"""The inspection engine's rules.

The one that matters most: **FAIL and INCONCLUSIVE are not the same**, and
neither is SKIPPED. A service that never claimed a capability cannot fail for
lacking it, and a probe that produced nothing is not a broken service — it is a
probe that produced nothing. Collapsing them turns "we did not check" into "it
is broken", which is how a tool gets ignored.
"""

from __future__ import annotations

import pytest

from llmbench.inspection import (
    ERROR,
    FAIL,
    INCONCLUSIVE,
    PASS,
    SKIPPED,
    SUPPORTED,
    UNKNOWN,
    CaseOutcome,
    Exchange,
    TargetFacts,
    _aborted_correctly,
    _model_ids,
    _sole_model,
    _stream_survived,
    aggregate,
    has_reasoning,
    safe_rejection,
    valid_completion,
    valid_tool_call,
)


def exchange(status: int | None = 200, body: object = None, text: str = "", error: str | None = None) -> Exchange:
    return Exchange("req-1", "case", "POST", "/x", status=status, body=body, text=text, error=error)


COMPLETION = {
    "choices": [{"message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 9, "completion_tokens": 2},
}


class TestValidCompletion:
    def test_a_well_formed_answer_passes(self):
        assert valid_completion(exchange(body=COMPLETION))

    def test_a_non_200_is_not_an_answer(self):
        assert not valid_completion(exchange(status=500, body=COMPLETION))

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"choices": []},
            {"choices": [{}]},
            {"choices": [{"message": {}}]},  # no finish_reason
            {"choices": [{"message": {}, "finish_reason": "weird"}]},
        ],
    )
    def test_a_malformed_body_is_not_an_answer(self, body):
        assert not valid_completion(exchange(body=body))

    def test_usage_is_required(self):
        """Without it there is no token accounting, and the run is unmeasurable."""
        body = {"choices": [{"message": {}, "finish_reason": "stop"}]}
        assert not valid_completion(exchange(body=body))


class TestSafeRejection:
    def test_a_structured_error_object_is_a_safe_rejection(self):
        assert safe_rejection(exchange(status=400, body={"error": {"message": "bad"}}))

    def test_sglangs_top_level_error_shape_is_also_accepted(self):
        """Its errors do not nest under `error`, and reading that as a failure
        would produce the false alarm the whole distinction exists to avoid."""
        body = {"object": "error", "message": "bad", "type": "BadRequestError"}
        assert safe_rejection(exchange(status=400, body=body))

    @pytest.mark.parametrize("status", [200, 302, 500, 503, None])
    def test_only_a_4xx_counts(self, status):
        assert not safe_rejection(exchange(status=status, body={"error": {"message": "bad"}}))

    def test_a_dropped_connection_is_not_a_rejection(self):
        assert not safe_rejection(exchange(status=None, error="ServerDisconnectedError"))

    def test_a_4xx_without_a_structured_body_is_not_a_rejection(self):
        assert not safe_rejection(exchange(status=400, body=None, text="bad request"))


class TestValidToolCall:
    def tool_body(self, arguments: str = '{"value": "pong"}') -> dict:
        return {
            "choices": [
                {
                    "message": {
                        "tool_calls": [{"function": {"name": "echo", "arguments": arguments}}]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }

    def test_a_proper_call_passes(self):
        assert valid_tool_call(exchange(body=self.tool_body()))

    def test_the_wrong_finish_reason_fails(self):
        body = self.tool_body()
        body["choices"][0]["finish_reason"] = "stop"
        assert not valid_tool_call(exchange(body=body))

    def test_unparsable_arguments_fail(self):
        assert not valid_tool_call(exchange(body=self.tool_body("{not json")))

    def test_the_wrong_function_name_fails(self):
        body = self.tool_body()
        body["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "other"
        assert not valid_tool_call(exchange(body=body))

    def test_a_non_string_argument_fails(self):
        assert not valid_tool_call(exchange(body=self.tool_body('{"value": 42}')))


class TestHasReasoning:
    def test_reasoning_content_is_seen(self):
        body = {"choices": [{"message": {"reasoning_content": "thinking"}}]}
        assert has_reasoning(exchange(body=body))

    def test_an_empty_reasoning_content_is_not_reasoning(self):
        body = {"choices": [{"message": {"reasoning_content": ""}}]}
        assert not has_reasoning(exchange(body=body))

    def test_a_missing_field_is_not_reasoning(self):
        assert not has_reasoning(exchange(body={"choices": [{"message": {}}]}))


class TestAggregate:
    def outcome(self, verdict: str, required: bool = True) -> CaseOutcome:
        return CaseOutcome("c", required, verdict, "r")

    def test_all_required_passing_is_a_pass(self):
        assert aggregate([self.outcome(PASS), self.outcome(PASS)]) == PASS

    def test_a_required_failure_fails_the_run(self):
        assert aggregate([self.outcome(PASS), self.outcome(FAIL)]) == FAIL

    def test_a_required_error_fails_the_run(self):
        assert aggregate([self.outcome(ERROR)]) == FAIL

    def test_an_optional_failure_does_not_fail_the_run(self):
        """A capability the service never claimed cannot fail it."""
        assert aggregate([self.outcome(PASS), self.outcome(FAIL, required=False)]) == PASS

    def test_inconclusive_is_reported_as_itself(self):
        """Not a pass, and emphatically not a failure."""
        assert aggregate([self.outcome(PASS), self.outcome(INCONCLUSIVE)]) == INCONCLUSIVE

    def test_failure_outranks_inconclusive(self):
        assert aggregate([self.outcome(INCONCLUSIVE), self.outcome(FAIL)]) == FAIL

    def test_skipped_does_not_affect_the_verdict(self):
        assert aggregate([self.outcome(PASS), self.outcome(SKIPPED)]) == PASS


# --- discovery helpers ------------------------------------------------------


class TestSoleModel:
    def test_exactly_one_named_model_is_accepted(self):
        body = {"data": [{"id": "only"}]}
        assert _sole_model(exchange(body=body)) == {"id": "only"}

    def test_two_models_are_refused(self):
        """Which one would we inspect? Guessing would produce verdicts about a
        service nobody chose."""
        body = {"data": [{"id": "a"}, {"id": "b"}]}
        assert _sole_model(exchange(body=body)) is None
        assert "a, b" in _model_ids(exchange(body=body))

    def test_no_models_is_refused(self):
        assert _sole_model(exchange(body={"data": []})) is None

    def test_a_non_200_is_refused(self):
        assert _sole_model(exchange(status=500, body={"data": [{"id": "a"}]})) is None

    def test_a_body_with_no_list_is_refused(self):
        assert _sole_model(exchange(body={})) is None
        assert _model_ids(exchange(body={})) == "nothing usable"


# --- abort storm helpers ----------------------------------------------------


def stream(**overrides) -> dict:
    base = {
        "events": 20,
        "invalid_events": 0,
        "done": True,
        "finish_reason": "length",
        "generated": 20,
        "stopped_at": None,
    }
    return {**base, **overrides}


class TestAbortCorrectness:
    def test_the_client_must_get_to_withdraw_where_it_meant_to(self):
        assert _aborted_correctly(exchange(), stream(generated=64, stopped_at=64), 64)

    def test_a_stream_that_ended_first_is_not_an_abort(self):
        """The test asked for something the service finished before reaching.
        That is a broken test, not a broken service."""
        assert not _aborted_correctly(exchange(), stream(generated=16, stopped_at=None), 64)

    def test_stopping_early_is_not_the_planned_abort(self):
        assert not _aborted_correctly(exchange(), stream(generated=16, stopped_at=16), 64)

    def test_a_non_200_abort_is_wrong(self):
        assert not _aborted_correctly(exchange(status=500), stream(stopped_at=64, generated=64), 64)


class TestSurvivor:
    def test_a_complete_stream_survived(self):
        assert _stream_survived(exchange(), stream())

    def test_a_stream_that_never_finished_did_not_survive(self):
        assert not _stream_survived(exchange(), stream(done=False))

    def test_a_stream_with_unparsable_events_did_not_survive(self):
        assert not _stream_survived(exchange(), stream(invalid_events=3))

    def test_a_stream_with_no_events_did_not_survive(self):
        assert not _stream_survived(exchange(), stream(events=0))

    def test_a_bad_finish_reason_did_not_survive(self):
        assert not _stream_survived(exchange(), stream(finish_reason=None))


# --- applicability ----------------------------------------------------------


class TestContextOverflowApplicability:
    def test_needs_both_a_known_context_and_a_tokenizer(self):
        from llmbench.inspection import context_overflow_applicable

        facts = TargetFacts("http://x", "m", context_length=1024, tokenizer_available=True)
        assert context_overflow_applicable(facts)
        assert not context_overflow_applicable(
            TargetFacts("http://x", "m", context_length=None, tokenizer_available=True)
        )
        assert not context_overflow_applicable(
            TargetFacts("http://x", "m", context_length=1024, tokenizer_available=False)
        )


def test_target_facts_record_an_unknown_capability_as_unknown():
    """Not as "unsupported" — those mean different things and lead to different
    verdicts."""
    facts = TargetFacts("http://x", "m")
    assert facts.tools == UNKNOWN
    assert facts.thinking == UNKNOWN
    assert facts.tools != SUPPORTED
