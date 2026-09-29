import asyncio
import copy
import json

import aiohttp
from aiohttp import web
import pytest

from llmbench import inspection as i


def reply(body=None, status=200, error=None):
    return i.Exchange("r", "", "POST", "/v1/chat/completions", status=status,
                      body=body, text=json.dumps(body), error=error)


def call_body():
    return {"choices": [{"finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": None, "tool_calls": [
            {"id": "call_1", "type": "function", "function": {
                "name": "get_weather", "arguments": '{"city":"Paris"}'}},
            {"id": "call_2", "type": "function", "function": {
                "name": "get_weather", "arguments": '{"city":"北京"}'}},
        ]}}]}


def completion(content='{"city":"Paris","temperature":20}', reason="stop"):
    return {"choices": [{"finish_reason": reason, "message": {
        "role": "assistant", "content": content}}], "usage": {}}


def stream_events():
    return [
        {"choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "id": "a", "type": "function", "function": {"name": "get_", "arguments": '{"city":'}},
            {"index": 1, "id": "b", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"北'}},
        ]}}]},
        {"choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 1, "function": {"arguments": '京"}'}},
            {"index": 0, "function": {"name": "weather", "arguments": '"Paris"}'}},
        ]}}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
        {"choices": [], "usage": {}},
        "[DONE]",
    ]


def sse(events):
    return "".join("data: " + (event if isinstance(event, str) else json.dumps(event, ensure_ascii=False))
                   + "\n\n" for event in events)


def test_stream_reassembles_multiple_interleaved_calls():
    assert i.valid_streamed_tool_calls(sse(stream_events()))


@pytest.mark.parametrize("mutation", [
    "no_done", "no_finish", "bad_json", "wrong_finish", "duplicate_id",
    "bad_index", "missing_id", "wrong_name", "bad_arguments", "after_done", "error_event",
])
def test_stream_rejects_broken_calls(mutation):
    events = stream_events()
    first = events[0]["choices"][0]["delta"]["tool_calls"]
    if mutation == "no_done":
        events.pop()
    elif mutation == "no_finish":
        events.pop(2)
    elif mutation == "bad_json":
        events.insert(1, "{")
    elif mutation == "wrong_finish":
        events[2]["choices"][0]["finish_reason"] = "length"
    elif mutation == "duplicate_id":
        first[1]["id"] = "a"
    elif mutation == "bad_index":
        first[0]["index"] = True
    elif mutation == "missing_id":
        del first[0]["id"]
    elif mutation == "wrong_name":
        first[0]["function"]["name"] = "other"
    elif mutation == "bad_arguments":
        first[0]["function"]["arguments"] = "[]"
    elif mutation == "after_done":
        events.append({"choices": []})
    elif mutation == "error_event":
        events.insert(1, {"error": {"message": "failed"}})
    assert not i.valid_streamed_tool_calls(sse(events))


def test_stream_over_http_handles_byte_boundaries_and_records_evidence():
    async def scenario():
        async def handler(request):
            payload = await request.json()
            assert payload["stream"] is True
            assert payload["tool_choice"]["function"]["name"] == "get_weather"
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            raw = sse(stream_events()).encode()
            for offset in range(0, len(raw), 7):
                await response.write(raw[offset:offset + 7])
                await asyncio.sleep(0)
            await response.write_eof()
            return response
        app = web.Application()
        app.router.add_post("/v1/chat/completions", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        evidence = []
        token = i._evidence_sink.set(evidence)
        try:
            async with aiohttp.ClientSession() as session:
                outcome = await i.case_extensions_tools_stream(session, i.TargetFacts(url, "m"))
            assert outcome.verdict == i.PASS
            assert len(evidence) == 1 and "[DONE]" in evidence[0]["response_body"]
        finally:
            i._evidence_sink.reset(token)
            await runner.cleanup()
    asyncio.run(scenario())


def test_roundtrip_preserves_ids_and_sends_each_result(monkeypatch):
    requests = []
    first = call_body()
    async def request(*args, **kwargs):
        requests.append(copy.deepcopy(kwargs["payload"]))
        return reply(first if len(requests) == 1 else completion("Weather received."))
    monkeypatch.setattr(i, "_request", request)
    outcome = asyncio.run(i.case_extensions_tools_roundtrip(None, i.TargetFacts("http://test", "m")))
    assert outcome.verdict == i.PASS
    second = requests[1]
    assert second["tool_choice"] == "none"
    assert second["messages"][1] == first["choices"][0]["message"]
    assert [r["tool_call_id"] for r in second["messages"][2:]] == ["call_1", "call_2"]
    assert json.loads(second["messages"][3]["content"])["city"] == "北京"


@pytest.mark.parametrize("status, body, verdict", [
    (500, None, i.FAIL), (400, None, i.FAIL), (429, None, i.INCONCLUSIVE),
    (200, completion(""), i.FAIL), (200, completion("partial", "length"), i.FAIL),
    (200, call_body(), i.FAIL),
])
def test_roundtrip_checks_second_response_even_when_capability_was_unknown(monkeypatch, status, body, verdict):
    responses = iter([reply(call_body()), reply(body, status)])
    async def request(*args, **kwargs):
        return next(responses)
    monkeypatch.setattr(i, "_request", request)
    assert asyncio.run(i.case_extensions_tools_roundtrip(None, i.TargetFacts("http://test", "m"))).verdict == verdict


def test_roundtrip_stops_before_followup_for_missing_ids(monkeypatch):
    body = call_body()
    del body["choices"][0]["message"]["tool_calls"][0]["id"]
    calls = []
    async def request(*args, **kwargs):
        calls.append(kwargs)
        return reply(body)
    monkeypatch.setattr(i, "_request", request)
    result = asyncio.run(i.case_extensions_tools_roundtrip(None, i.TargetFacts("http://test", "m", tools=i.SUPPORTED)))
    assert result.verdict == i.FAIL and len(calls) == 1


@pytest.mark.parametrize("content, verdict", [
    ('{"city":"Paris","temperature":20}', i.PASS),
    ('{"city":"Paris","temperature":20.0}', i.PASS),
    ('{"city":"北京","temperature":-2}', i.PASS),
    ('{"city":"Paris","temperature":true}', i.FAIL),
    ('{"city":"Paris","temperature":"20"}', i.FAIL),
    ('{"city":"Paris","temperature":20.5}', i.FAIL),
    ('{"city":"Paris"}', i.FAIL),
    ('{"city":"Paris","temperature":20,"extra":1}', i.FAIL),
    ('[]', i.FAIL), ('null', i.FAIL), ('not JSON', i.FAIL),
    ('{"city":"Paris","temperature":NaN}', i.FAIL),
])
def test_structured_output_validates_schema(monkeypatch, content, verdict):
    async def request(*args, **kwargs):
        format_ = kwargs["payload"]["response_format"]
        assert format_["type"] == "json_schema"
        assert format_["json_schema"]["strict"] is True
        assert format_["json_schema"]["schema"]["additionalProperties"] is False
        return reply(completion(content))
    monkeypatch.setattr(i, "_request", request)
    assert asyncio.run(i.case_extensions_structured_output(None, i.TargetFacts("http://test", "m"))).verdict == verdict


@pytest.mark.parametrize("probe", [i.case_extensions_tools_stream, i.case_extensions_tools_roundtrip, i.case_extensions_structured_output])
@pytest.mark.parametrize("status,error,verdict", [(400,None,i.INCONCLUSIVE), (500,None,i.FAIL),
    (401,None,i.INCONCLUSIVE), (429,None,i.INCONCLUSIVE), (None,"disconnected",i.ERROR)])
def test_capability_errors_are_not_misreported(monkeypatch, probe, status, error, verdict):
    async def request(*args, **kwargs):
        return reply(status=status, error=error)
    async def stream(*args, **kwargs):
        return reply(status=status, error=error), {}
    monkeypatch.setattr(i, "_request", request)
    monkeypatch.setattr(i, "_stream_request", stream)
    assert asyncio.run(probe(None, i.TargetFacts("http://test", "m"))).verdict == verdict


def test_catalogue_exposes_new_cases_and_guides():
    cases = {c["case_id"]: c for c in i.case_catalogue()}
    for case_id in ("extensions.tools_stream", "extensions.tools_roundtrip", "extensions.structured_output"):
        assert cases[case_id]["steps"] and cases[case_id]["default_enabled"]
        assert "suite_version" not in cases[case_id]


@pytest.mark.parametrize("probe", [i.case_extensions_tools_stream, i.case_extensions_tools_roundtrip])
def test_explicitly_unsupported_tools_skip_without_a_request(probe):
    result = asyncio.run(probe(None, i.TargetFacts("http://test", "m", tools=i.UNSUPPORTED)))
    assert result.verdict == i.SKIPPED


@pytest.mark.parametrize("reason,refusal", [("length", None), ("stop", "refused")])
def test_incomplete_structured_output_is_inconclusive(monkeypatch, reason, refusal):
    body = completion("partial", reason)
    body["choices"][0]["message"]["refusal"] = refusal
    async def request(*args, **kwargs):
        return reply(body)
    monkeypatch.setattr(i, "_request", request)
    result = asyncio.run(i.case_extensions_structured_output(None, i.TargetFacts("http://test", "m")))
    assert result.verdict == i.INCONCLUSIVE
