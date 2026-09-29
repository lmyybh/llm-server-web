import asyncio
import pytest
from llmbench import inspection as i
from llmbench import inspection_long as long


def response(body=None, status=200):
    return i.Exchange("", "", "POST", "", status=status, body=body, text=str(body))


def test_long_input_counts_complete_messages_and_reserves_output(monkeypatch):
    sent = []
    async def request(session, method, url, **kwargs):
        payload = kwargs["payload"]
        if url.endswith("tokenize"):
            count = 20 + payload["messages"][0]["content"].count("sample ")
            return response({"count": count})
        sent.append(payload)
        return response({"choices": [{"finish_reason": "stop", "message": {"content": "OK"}}], "usage": {}})
    monkeypatch.setattr(i, "_request", request)
    result = asyncio.run(long.case_long_input(None, i.TargetFacts("http://test", "m", 1000, True)))
    assert result.verdict == i.PASS
    count = 20 + sent[0]["messages"][0]["content"].count("sample ")
    assert 900 <= count <= 901
    assert count + sent[0]["max_tokens"] <= 1000
    assert "900" in result.message


@pytest.mark.parametrize("actual,done,reason,expected", [
    (900,True,"length",i.PASS), (800,True,"stop",i.INCONCLUSIVE),
    (901,True,"length",i.FAIL), (900,False,"length",i.FAIL),
    (None,True,"stop",i.INCONCLUSIVE), (True,True,"stop",i.INCONCLUSIVE),
])
def test_long_output_coverage(monkeypatch, actual, done, reason, expected):
    async def request(*args, **kwargs):
        return response({"count": 50})
    async def stream(*args, **kwargs):
        assert kwargs["payload"]["max_tokens"] == 900
        assert kwargs["payload"]["stream_options"]["include_usage"]
        return response(), {"events": 4, "generated": 2, "invalid_events": 0, "done": done, "finish_reason": reason,
                            "usage": {"completion_tokens": actual}}
    monkeypatch.setattr(i, "_request", request)
    monkeypatch.setattr(i, "_stream_request", stream)
    result = asyncio.run(long.case_long_output(None, i.TargetFacts("http://test", "m", 1000, True)))
    assert result.verdict == expected
    assert "900" in result.message


def test_output_limit_does_not_silently_reduce_target():
    result = asyncio.run(long.case_long_output(None, i.TargetFacts(
        "http://test", "m", 1000, True, max_output_tokens=500)))
    assert result.reason_code == "output_limit_below_target"


def test_input_plus_output_budget_is_checked(monkeypatch):
    async def request(*args, **kwargs):
        return response({"count": 101})
    monkeypatch.setattr(i, "_request", request)
    result = asyncio.run(long.case_long_output(None, i.TargetFacts("http://test", "m", 1000, True)))
    assert result.reason_code == "budget_unavailable"


@pytest.mark.parametrize("probe", [long.case_long_input, long.case_long_output])
def test_missing_prerequisites_skip(probe):
    assert asyncio.run(probe(None, i.TargetFacts("http://test", "m"))).verdict == i.SKIPPED


def test_long_input_never_sends_generation_without_meeting_target(monkeypatch):
    async def request(session, method, url, **kwargs):
        assert url.endswith("/v1/tokenize")
        return response({"count": 5})
    monkeypatch.setattr(i, "_request", request)
    result = asyncio.run(long.case_long_input(None, i.TargetFacts("http://test", "m", 1000, True)))
    assert result.reason_code == "input_target_unreached"


def test_long_cases_are_opt_in():
    cases = {c["case_id"]: c for c in i.case_catalogue()}
    for id_ in ("context.long_input", "output.long_generation"):
        assert cases[id_]["default_enabled"] is False
        assert cases[id_]["group"] == "长序列"


def test_output_over_http_retains_usage_and_evidence():
    import json
    import aiohttp
    from aiohttp import web
    async def scenario():
        async def tokenize(request):
            return web.json_response({"count": 50})
        async def generate(request):
            payload = await request.json()
            assert payload["max_tokens"] == 900
            events = [
                {"choices": [{"delta": {"content": "long answer"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "length"}]},
                {"choices": [], "usage": {"completion_tokens": 900}},
            ]
            body = "".join("data: " + json.dumps(event) + "\n\n" for event in events)
            return web.Response(text=body + "data: [DONE]\n", content_type="text/event-stream")
        app = web.Application()
        app.router.add_post("/v1/tokenize", tokenize)
        app.router.add_post("/v1/chat/completions", generate)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        evidence = []
        token = i._evidence_sink.set(evidence)
        try:
            async with aiohttp.ClientSession() as session:
                result = await long.case_long_output(session, i.TargetFacts(base, "m", 1000, True))
            assert result.verdict == i.PASS
            assert "实际 900" in result.message
            assert len(evidence) == 2 and "[DONE]" in evidence[-1]["response_body"]
        finally:
            i._evidence_sink.reset(token)
            await runner.cleanup()
    asyncio.run(scenario())
