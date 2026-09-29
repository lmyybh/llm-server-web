"""Evidence and lifecycle regressions for inspection suite 8."""
import asyncio

import pytest

from llmbench import inspection as i


def reply(status=200, body=None):
    return i.Exchange('r', 'c', 'POST', '/test', status=status, body=body)


@pytest.mark.parametrize('cases, expected', [
    ([i.CaseOutcome('c', True, i.ERROR, 'inspector_error')], i.ERROR),
    ([i.CaseOutcome('c', False, i.FAIL, 'assertion_failed')], i.FAIL),
    ([i.CaseOutcome('c', False, i.SKIPPED, 'unsupported')], i.INCONCLUSIVE),
    ([], i.INCONCLUSIVE),
])
def test_summary_does_not_invent_service_health(cases, expected):
    assert i.aggregate(cases) == expected


@pytest.mark.parametrize('status', [401, 403, 404, 408, 429])
def test_unrelated_rejections_are_not_validation_success(status):
    assert not i.safe_rejection(reply(status, {'error': {'message': 'rejected'}}))


@pytest.mark.parametrize('count', [None, '1', True, -1])
def test_limit_requires_usable_token_count(monkeypatch, count):
    async def request(*args, **kwargs):
        return reply(body={'choices': [{'message': {'content': 'x'}, 'finish_reason': 'length'}],
                           'usage': {'completion_tokens': count}})
    monkeypatch.setattr(i, '_request', request)
    outcome = asyncio.run(i.case_output_small_limit(None, i.TargetFacts('http://test', 'm')))
    assert outcome.verdict == i.INCONCLUSIVE


def test_overflow_is_not_sent_without_proven_overflow(monkeypatch):
    paths = []
    async def request(session, method, url, **kwargs):
        paths.append(url)
        return reply(body={'count': 2})
    monkeypatch.setattr(i, '_request', request)
    outcome = asyncio.run(i.case_context_overflow(None, i.TargetFacts('http://test', 'm', context_length=8, tokenizer_available=True)))
    assert outcome.verdict == i.INCONCLUSIVE
    assert paths == ['http://test/v1/tokenize']


@pytest.mark.parametrize('verdict', [i.FAIL, i.ERROR])
def test_failed_disruption_still_checks_recovery(monkeypatch, verdict):
    calls = []
    async def discover(*args, **kwargs):
        return i.TargetFacts('http://test', 'm'), []
    async def probe(*args, **kwargs):
        return i.CaseOutcome('disruption', True, verdict, 'original_failure')
    async def recovery(*args, **kwargs):
        calls.append('recovery')
        return True
    monkeypatch.setattr(i, 'discover', discover)
    monkeypatch.setattr(i, 'catalogue', lambda: [i.Case('disruption', probe, recovery_required=True, disruptive=True)])
    monkeypatch.setattr(i, 'verify_recovery', recovery)
    summary = asyncio.run(i.run_inspection('http://test'))
    assert calls == ['recovery']
    assert summary.cases[0].verdict == verdict
    assert summary.cases[0].reason_code == 'original_failure'


def test_recovery_has_a_hard_deadline(monkeypatch):
    async def request(*args, **kwargs):
        await asyncio.sleep(0.2)
        return reply()
    monkeypatch.setattr(i, '_request', request)
    monkeypatch.setattr(i, 'RECOVERY_DEADLINE_SECONDS', 0.01)
    async def scenario():
        return await asyncio.wait_for(i.verify_recovery(None, i.TargetFacts('http://test', 'm')), 0.1)
    with pytest.raises(TimeoutError, match="recovery deadline expired"):
        asyncio.run(scenario())


@pytest.mark.parametrize('case_id, body, expected', [
    ('validation.malformed_json', {'error': {'message': 'invalid JSON'}}, i.PASS),
    ('validation.missing_messages', {'error': {'message': 'messages is required'}}, i.PASS),
    ('validation.wrong_field_type', {'error': {'param': 'temperature', 'message': 'invalid type'}}, i.PASS),
    ('context.overflow', {'error': {'code': 'context_length_exceeded'}}, i.PASS),
    ('validation.missing_messages', {'error': {'message': 'unknown model'}}, i.INCONCLUSIVE),
    ('validation.malformed_json', {'error': {'message': 'bad request'}}, i.INCONCLUSIVE),
])
def test_rejection_must_identify_the_tested_input(case_id, body, expected):
    assert i.rejection_outcome(case_id, reply(400, body)).verdict == expected


def test_unknown_optional_capability_500_fails_the_run(monkeypatch):
    async def request(*args, **kwargs):
        return reply(503, {'error': {'message': 'server failed'}})
    monkeypatch.setattr(i, '_request', request)
    outcome = asyncio.run(i.case_extensions_tools(None, i.TargetFacts('http://test', 'm')))
    assert outcome.required is False
    assert i.aggregate([outcome]) == i.FAIL


@pytest.mark.parametrize('case_budget, expected', [(0.5, i.PASS), (0.01, i.ERROR)])
def test_case_deadline_controls_http_request_budget(monkeypatch, case_budget, expected):
    from aiohttp import web

    async def scenario():
        async def completion(request):
            await asyncio.sleep(0.05)
            return web.json_response({'choices': [{'message': {'content': 'pong'}, 'finish_reason': 'stop'}], 'usage': {}})
        app = web.Application()
        app.router.add_post('/v1/chat/completions', completion)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        base = f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        async def discover(*args, **kwargs):
            return i.TargetFacts(base, 'm'), []
        monkeypatch.setattr(i, 'discover', discover)
        monkeypatch.setattr(i, 'CASE_TIMEOUT_SECONDS', 0.001)
        monkeypatch.setattr(i, 'catalogue', lambda: [i.Case('completion.non_stream', i.case_completion_non_stream, timeout_seconds=case_budget)])
        try:
            return await i.run_inspection(base)
        finally:
            await runner.cleanup()
    summary = asyncio.run(scenario())
    assert summary.run_verdict == expected


def test_recovery_timeout_retains_original_failure(monkeypatch):
    async def discover(*args, **kwargs):
        return i.TargetFacts('http://test', 'm'), []
    async def probe(*args, **kwargs):
        return i.CaseOutcome('disruption', True, i.FAIL, 'assertion_failed', 'survivors failed')
    async def recovery(*args, **kwargs):
        return False
    monkeypatch.setattr(i, 'discover', discover)
    monkeypatch.setattr(i, 'catalogue', lambda: [i.Case('disruption', probe, recovery_required=True)])
    monkeypatch.setattr(i, 'verify_recovery', recovery)
    summary = asyncio.run(i.run_inspection('http://test'))
    assert summary.cases[0].reason_code == 'assertion_failed'
    assert 'survivors failed' in summary.cases[0].message
    assert 'recovery' in summary.cases[0].message
