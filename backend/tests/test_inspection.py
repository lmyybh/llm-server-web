"""The inspection engine's rules.

The one that matters most: **FAIL and INCONCLUSIVE are not the same**, and
neither is SKIPPED. A service that never claimed a capability cannot fail for
lacking it, and a probe that produced nothing is not a broken service — it is a
probe that produced nothing. Collapsing them turns "we did not check" into "it
is broken", which is how a tool gets ignored.
"""

from __future__ import annotations

import asyncio

import pytest
from aiohttp import web

from llmbench import inspection

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
    def tool_body(self, arguments: str = '{"city": "Paris"}') -> dict:
        return {
            "choices": [
                {
                    "message": {
                        "tool_calls": [{"function": {"name": "get_weather", "arguments": arguments}}]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }

    def test_a_proper_call_passes(self):
        assert valid_tool_call(exchange(body=self.tool_body()))

    def test_a_complete_call_with_length_finish_reason_fails(self):
        body = self.tool_body()
        body["choices"][0]["finish_reason"] = "length"
        assert not valid_tool_call(exchange(body=body))

    def test_a_complete_call_with_stop_finish_reason_fails(self):
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
        assert not valid_tool_call(exchange(body=self.tool_body('{"city": 42}')))

    def test_a_missing_city_argument_fails(self):
        assert not valid_tool_call(exchange(body=self.tool_body('{"value": "pong"}')))

    def test_a_non_object_argument_fails(self):
        assert not valid_tool_call(exchange(body=self.tool_body('"pong"')))

    def test_every_returned_tool_call_must_be_valid(self):
        body = self.tool_body()
        body["choices"][0]["message"]["tool_calls"].append(
            {"function": {"name": "get_weather", "arguments": "{"}}
        )
        assert not valid_tool_call(exchange(body=body))


@pytest.mark.parametrize("finish_reason, expected", [("tool_calls", PASS), ("length", FAIL)])
def test_tool_probe_requires_tool_calls_finish_reason(finish_reason, expected):
    async def scenario():
        async def completion(request):
            payload = await request.json()
            assert set(payload) == {"model", "messages", "tools"}
            assert payload["model"] == "test-model"
            assert payload["messages"] == [{"role": "user", "content": "What's the weather in Paris?"}]
            assert payload["tools"] == [{
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get the current weather for a city",
                    "parameters": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}},
                        "required": ["city"],
                    },
                },
            }]
            return web.json_response({
                "choices": [{
                    "finish_reason": finish_reason,
                    "message": {"content": "", "tool_calls": [
                        {"type": "function", "function": {"name": "get_weather", "arguments": '{"city": "Paris"}'}}
                        for _ in range(4)
                    ]},
                }],
            })

        app = web.Application()
        app.router.add_post("/v1/chat/completions", completion)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base_url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            facts = TargetFacts(base_url, "test-model", tools=SUPPORTED)
            async with inspection.aiohttp.ClientSession() as session:
                outcome = await inspection.case_extensions_tools(session, facts)
        finally:
            await runner.cleanup()
        assert outcome.verdict == expected

    asyncio.run(scenario())


def test_general_and_thinking_probes_do_not_limit_output_tokens():
    facts = TargetFacts("http://example.invalid", "test-model")
    for payload in (
        inspection.baseline_payload(facts),
        inspection.thinking_request(facts, True),
        inspection.thinking_request(facts, False),
    ):
        assert "max_tokens" not in payload


def test_context_overflow_probe_does_not_limit_output_tokens():
    async def scenario():
        async def completion(request):
            payload = await request.json()
            assert "max_tokens" not in payload
            return web.json_response({"error": {"message": "context too long"}}, status=400)

        app = web.Application()
        app.router.add_post("/v1/chat/completions", completion)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base_url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            facts = TargetFacts(base_url, "test-model", context_length=8, tokenizer_available=True)
            async with inspection.aiohttp.ClientSession() as session:
                outcome = await inspection.case_context_overflow(session, facts)
        finally:
            await runner.cleanup()
        assert outcome.verdict == PASS

    asyncio.run(scenario())


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


def test_selected_case_emits_complete_request_and_response(monkeypatch):
    async def scenario():
        app = web.Application()
        app.router.add_get("/health_generate", lambda _: web.Response(text='{"status":"ready"}'))
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        base_url = f"http://127.0.0.1:{port}"

        async def fake_discover(url, *, api_key=None):
            return TargetFacts(base_url=url, model="test-model"), []

        monkeypatch.setattr(inspection, "discover", fake_discover)
        events = []
        try:
            summary = await inspection.run_inspection(
                base_url, selected_case_ids=["health.generate"], on_event=events.append
            )
        finally:
            await runner.cleanup()
        assert [case.case_id for case in summary.cases] == ["health.generate"]
        finished = next(event for event in events if event["type"] == "case_finished")
        assert finished["ordinal"] == 0
        assert finished["evidence"][0]["method"] == "GET"
        assert finished["evidence"][0]["request_body"] is None
        assert finished["evidence"][0]["response_body"] == '{"status":"ready"}'

    asyncio.run(scenario())
