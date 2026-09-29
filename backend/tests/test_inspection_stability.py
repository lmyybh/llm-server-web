import asyncio
import json

import pytest

from llmbench import inspection as i
from llmbench import inspection_stability as s


def exchange(status=200, error=None):
    return i.Exchange("", "", "POST", "", status=status, error=error)


def summary(**changes):
    value = dict(done=True, generated=2, finish_reason="length", invalid_events=0,
                 usage=dict(prompt_tokens=s.INPUT_TOKENS, completion_tokens=s.OUTPUT_TOKENS))
    value.update(changes)
    return value


@pytest.mark.parametrize("status,error,data,expected", [
    (200, None, summary(), "success"),
    (429, None, summary(), "rate_limited"),
    (500, None, summary(), "server_error"),
    (400, None, summary(), "rejected"),
    (None, "reset", summary(), "connection_error"),
    (200, None, summary(done=False), "invalid_stream"),
    (200, None, summary(usage={}), "unmeasured"),
    (200, None, summary(usage=dict(prompt_tokens=102400, completion_tokens=20)), "under_target"),
    (200, None, summary(usage=dict(prompt_tokens=102400, completion_tokens=2049)), "output_over_limit"),
])
def test_classification(status, error, data, expected):
    assert s.classify(exchange(status, error), data)[0] == expected


def test_budget_and_prerequisites():
    assert asyncio.run(s.case_high_concurrency(None, i.TargetFacts("x", "m"))).verdict == i.SKIPPED
    outcome = asyncio.run(s.case_high_concurrency(None, i.TargetFacts("x", "m", 100000, True)))
    assert outcome.reason_code == "load_budget_unavailable"
    assert next(c for c in i.catalogue() if c.case_id == s.CASE_ID).default_enabled is False


def test_random_inputs_are_calibrated_and_unique(monkeypatch):
    async def count(session, facts, messages, key):
        return exchange(), len(messages[0]["content"]) // 2
    monkeypatch.setattr(s, "count_input", count)
    async def run():
        facts = i.TargetFacts("x", "m", 131072, True)
        first = await s.prepare_payload(None, facts, None)
        second = await s.prepare_payload(None, facts, None)
        assert first[2] != second[2]
        for payload, count, _ in [first, second]:
            assert 102400 <= count <= 102502
            assert payload["ignore_eos"] is True
            assert payload["max_tokens"] == 2048
    asyncio.run(run())


@pytest.mark.parametrize("status,expected", [(200, i.PASS), (500, i.FAIL), (429, i.INCONCLUSIVE), (0, None)])
def test_sustained_concurrency_and_recovery(monkeypatch, status, expected):
    active = 0
    peak = 0
    created = 0
    recovery_calls = []
    async def prepare(*args):
        nonlocal created
        created += 1
        return {"id": created}, s.INPUT_TOKENS, str(created)
    async def request(*args, **kwargs):
        return exchange()
    async def baseline(*args, **kwargs):
        return i.CaseOutcome("baseline", True, i.PASS, "ok")
    async def stream(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(active, peak)
        try:
            await asyncio.sleep(.015)
            return exchange(status), summary()
        finally:
            active -= 1
    async def recovery(*args, **kwargs):
        assert active == 0
        recovery_calls.append(kwargs["timeout_seconds"])
        return True
    monkeypatch.setattr(s, "prepare_payload", prepare)
    monkeypatch.setattr(s, "DURATION_SECONDS", .15)
    monkeypatch.setattr(i, "_request", request)
    monkeypatch.setattr(i, "case_completion_non_stream", baseline)
    monkeypatch.setattr(i, "case_streaming_basic", baseline)
    monkeypatch.setattr(i, "_stream_request", stream)
    monkeypatch.setattr(i, "verify_recovery", recovery)
    async def run():
        evidence = []
        token = i._evidence_sink.set(evidence)
        try:
            task = asyncio.create_task(s.case_high_concurrency(None, i.TargetFacts("x", "m", 131072, True)))
            if status == 0:
                while active < 64:
                    await asyncio.sleep(0)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert active == 0
                assert recovery_calls == [60]
                metrics = json.loads(evidence[-1]["response_body"])
                assert metrics["counts"]["cancelled"] == 64
                return
            outcome = await task
        finally:
            i._evidence_sink.reset(token)
        assert outcome.verdict == expected
        metrics = json.loads(evidence[-1]["response_body"])
        assert metrics["peak_in_flight"] == 64
        if status == 200:
            assert metrics["counts"]["started"] > 64
            assert metrics["completed_window"] is True
        else:
            assert metrics["counts"]["started"] == 64
        assert peak == 64 and active == 0
        assert recovery_calls == [60]
    asyncio.run(run())
