"""Interface inspection: is this service behaving, right now.

Not a benchmark. It sends a small, fixed set of requests that a healthy
OpenAI-compatible chat service must answer correctly, and reports which ones it
did not. Nothing here measures throughput or latency — those are the bench's
job, and mixing the two produces a tool that does neither well.

The distinction the whole module is built around: **FAIL is not the same as
INCONCLUSIVE**. FAIL means the service broke a contract. INCONCLUSIVE means we
could not tell — a capability the service does not advertise, or a probe that
produced no usable evidence. Collapsing them would turn "we did not check" into
"it is broken", which is the kind of false alarm that gets a tool ignored.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import aiohttp

SUITE_VERSION = "3"
"""Bumped whenever the catalogue changes. Two Inspection Runs with different
suite versions are not comparable, and the number is what says so."""

HEALTH_PATH = "/health"
"""SGLang answers this without an API key. A service that fails it is not
reachable at all, which is a discovery failure rather than a case failure."""

DISCOVERY_TIMEOUT_SECONDS = 20.0
CASE_TIMEOUT_SECONDS = 60.0

PASS, FAIL, SKIPPED, INCONCLUSIVE, ERROR = "PASS", "FAIL", "SKIPPED", "INCONCLUSIVE", "ERROR"

SUPPORTED, UNSUPPORTED, UNKNOWN = "supported", "unsupported", "unknown"


class DiscoveryError(RuntimeError):
    """The service did not tell us enough to inspect it."""


@dataclass(frozen=True)
class TargetFacts:
    """What the service said about itself, before any case ran."""

    base_url: str
    model: str
    context_length: int | None = None
    tokenizer_available: bool = False
    tools: str = UNKNOWN
    thinking: str = UNKNOWN
    server_kind: str = "openai-compatible"
    server_version: str | None = None

    def as_dict(self) -> dict:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "context_length": self.context_length,
            "tokenizer_available": self.tokenizer_available,
            "tools": self.tools,
            "thinking": self.thinking,
            "server_kind": self.server_kind,
            "server_version": self.server_version,
        }


@dataclass
class Exchange:
    """One request and what came back. Facts only — no verdicts."""

    request_id: str
    case_id: str
    method: str
    path: str
    status: int | None = None
    body: object = None
    text: str = ""
    latency_ms: float = 0.0
    error: str | None = None


@dataclass
class CaseOutcome:
    case_id: str
    required: bool
    verdict: str
    reason_code: str
    message: str = ""

    def as_dict(self) -> dict:
        return {
            "case_id": self.case_id,
            "required": self.required,
            "verdict": self.verdict,
            "reason_code": self.reason_code,
            "message": self.message,
        }


@dataclass
class RunSummary:
    suite_version: str
    target: TargetFacts | None
    cases: list[CaseOutcome] = field(default_factory=list)
    run_verdict: str = INCONCLUSIVE

    def as_dict(self) -> dict:
        return {
            "suite_version": self.suite_version,
            "target": self.target.as_dict() if self.target else None,
            "verdict": self.run_verdict,
            "cases": [case.as_dict() for case in self.cases],
        }


# --- HTTP -------------------------------------------------------------------


def auth_headers(api_key: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _request(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict | None = None,
    raw_body: str | None = None,
) -> Exchange:
    started = time.monotonic()
    exchange = Exchange(
        request_id=f"req-{int(started * 1000) % 10_000_000:07d}",
        case_id="",
        method=method,
        path=url,
    )
    try:
        kwargs: dict = {"headers": headers}
        if raw_body is not None:
            kwargs["data"] = raw_body
        elif payload is not None:
            kwargs["json"] = payload
        async with session.request(method, url, **kwargs) as response:
            exchange.status = response.status
            exchange.text = await response.text()
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        exchange.error = f"{type(exc).__name__}: {exc}"
    exchange.latency_ms = round((time.monotonic() - started) * 1000, 3)
    try:
        exchange.body = json.loads(exchange.text)
    except (json.JSONDecodeError, ValueError):
        exchange.body = None
    return exchange


# --- discovery --------------------------------------------------------------


async def discover(
    base_url: str, *, api_key: str | None = None, timeout: float = DISCOVERY_TIMEOUT_SECONDS
) -> tuple[TargetFacts, list[Exchange]]:
    """Ask the service what it is. Fails rather than assuming.

    Assumptions here would be worse than usual: every case below decides what to
    do based on what discovery found, so a guess would propagate into verdicts
    that look considered and are not.
    """
    base = base_url.rstrip("/")
    headers = auth_headers(api_key)
    exchanges: list[Exchange] = []
    client_timeout = aiohttp.ClientTimeout(total=timeout)

    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        health = await _request(session, "GET", f"{base}{HEALTH_PATH}", headers=headers)
        health.case_id = "discovery"
        exchanges.append(health)
        if health.status != 200:
            raise DiscoveryError(
                f"{HEALTH_PATH} returned {health.status or health.error}"
            )

        models = await _request(session, "GET", f"{base}/v1/models", headers=headers)
        models.case_id = "discovery"
        exchanges.append(models)
        model = _sole_model(models)
        if model is None:
            raise DiscoveryError(
                f"/v1/models must name exactly one model; got {_model_ids(models)}"
            )

        context_length = _positive_int(model.get("max_model_len")) or _positive_int(
            model.get("context_length")
        )

        info = await _request(session, "GET", f"{base}/model_info", headers=headers)
        info.case_id = "discovery"
        exchanges.append(info)
        tools = thinking = UNKNOWN
        server_kind = "openai-compatible"
        server_version = None
        if info.status == 200 and isinstance(info.body, dict):
            if info.body.get("model_path"):
                server_kind = "sglang"
            tools = SUPPORTED if info.body.get("tool_call_parser") else UNKNOWN
            thinking = SUPPORTED if info.body.get("reasoning_parser") else UNKNOWN
            if info.body.get("version") is not None:
                server_version = str(info.body["version"])

        tokenize = await _request(
            session,
            "POST",
            f"{base}/v1/tokenize",
            headers=headers,
            payload={"model": model["id"], "messages": [{"role": "user", "content": "probe"}]},
        )
        tokenize.case_id = "discovery"
        exchanges.append(tokenize)
        tokenizer_available = (
            tokenize.status == 200
            and isinstance(tokenize.body, dict)
            and _positive_int(tokenize.body.get("count")) is not None
        )
        if tokenizer_available:
            context_length = _positive_int(tokenize.body.get("max_model_len")) or context_length

    return (
        TargetFacts(
            base_url=base,
            model=str(model["id"]),
            context_length=context_length,
            tokenizer_available=tokenizer_available,
            tools=tools,
            thinking=thinking,
            server_kind=server_kind,
            server_version=server_version,
        ),
        exchanges,
    )


def _sole_model(models: Exchange) -> dict | None:
    if models.status != 200 or not isinstance(models.body, dict):
        return None
    entries = models.body.get("data")
    if not isinstance(entries, list):
        return None
    named = [entry for entry in entries if isinstance(entry, dict) and entry.get("id")]
    return named[0] if len(named) == 1 else None


def _model_ids(models: Exchange) -> str:
    if not isinstance(models.body, dict):
        return "nothing usable"
    entries = models.body.get("data")
    if not isinstance(entries, list):
        return "nothing usable"
    return ", ".join(str(entry.get("id")) for entry in entries if isinstance(entry, dict)) or "none"


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and value > 0 else None


# --- assertions -------------------------------------------------------------


def valid_completion(exchange: Exchange) -> bool:
    """A well-formed non-streaming chat response."""
    if exchange.status != 200 or not isinstance(exchange.body, dict):
        return False
    choices = exchange.body.get("choices")
    if not isinstance(choices, list) or not choices:
        return False
    first = choices[0]
    if not isinstance(first, dict) or not isinstance(first.get("message"), dict):
        return False
    if first.get("finish_reason") not in {"stop", "length", "tool_calls"}:
        return False
    return isinstance(exchange.body.get("usage"), dict)


def safe_rejection(exchange: Exchange) -> bool:
    """A structured 4xx, rather than a crash or a shrug.

    A service that answers a malformed request with 200, a 5xx, or a dropped
    connection is not being strict — it is being unreliable, and a client
    cannot tell the difference between that and an outage.
    """
    if exchange.status is None or not (400 <= exchange.status < 500):
        return False
    body = exchange.body
    if not isinstance(body, dict):
        return False
    if isinstance(body.get("error"), dict):
        return True
    # SGLang's top-level error shape.
    return (
        body.get("object") == "error"
        and isinstance(body.get("message"), str)
        and isinstance(body.get("type"), str)
    )


# --- cases ------------------------------------------------------------------

CaseRunner = Callable[..., Awaitable[CaseOutcome]]


@dataclass(frozen=True)
class Case:
    case_id: str
    run: CaseRunner
    required: bool = True
    applicable: Callable[[TargetFacts], bool] | None = None
    timeout_seconds: float = CASE_TIMEOUT_SECONDS
    recovery_required: bool = False
    disruptive: bool = False


async def case_completion_non_stream(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """The floor: a plain request that produces a well-formed answer."""
    exchange = await _request(
        session,
        "POST",
        f"{facts.base_url}/v1/chat/completions",
        headers=auth_headers(api_key),
        payload=baseline_payload(facts),
    )
    exchange.case_id = "completion.non_stream"
    return _outcome("completion.non_stream", valid_completion(exchange), exchange)


async def case_health_generate(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """The service's own "can I generate" probe.

    Necessary but **not sufficient**, which is why it is one case among many
    rather than the health check: a service can answer this while its real
    generation path is wedged. The cases that follow are what actually prove
    generation works; this one proves the endpoint exists and answers.
    """
    case_id = "health.generate"
    exchange = await _request(
        session, "GET", f"{facts.base_url}/health_generate", headers=auth_headers(api_key)
    )
    exchange.case_id = case_id
    if exchange.error:
        return CaseOutcome(case_id, True, ERROR, "inspector_error", exchange.error)
    # Only 200 counts. A 404 means the endpoint is absent, and a 5xx means it is
    # answering badly — neither is "the service is fine".
    return _outcome(case_id, exchange.status == 200, exchange)


async def case_streaming_basic(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """A streamed answer that actually streams and actually ends."""
    payload = {**baseline_payload(facts), "stream": True}
    exchange, stream = await _stream_request(
        session, f"{facts.base_url}/v1/chat/completions", headers=auth_headers(api_key), payload=payload
    )
    exchange.case_id = "streaming.basic"
    case_id = "streaming.basic"

    if exchange.error:
        return CaseOutcome(case_id, True, ERROR, "inspector_error", exchange.error)
    if exchange.status != 200:
        return CaseOutcome(
            case_id, True, FAIL, "assertion_failed", f"HTTP {exchange.status}: {exchange.text[:200]}"
        )
    if stream["invalid_events"]:
        return CaseOutcome(
            case_id, True, FAIL, "assertion_failed", f"{stream['invalid_events']} unparsable event(s)"
        )
    if not stream["events"]:
        return CaseOutcome(case_id, True, FAIL, "assertion_failed", "the stream produced no events")
    if not stream["done"]:
        return CaseOutcome(case_id, True, FAIL, "assertion_failed", "the stream never sent [DONE]")
    if stream["finish_reason"] not in {"stop", "length", "tool_calls"}:
        return CaseOutcome(
            case_id, True, FAIL, "assertion_failed", f"finish_reason {stream['finish_reason']!r}"
        )
    return CaseOutcome(case_id, True, PASS, "assertions_passed")


async def _stream_request(
    session: aiohttp.ClientSession,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict,
    stop_after_tokens: int | None = None,
) -> tuple[Exchange, dict]:
    """Send a streaming request and summarise what came back.

    ``stop_after_tokens`` disconnects once that many content events have been
    parsed — counted in *events*, not bytes or chunks, because a chunk is a
    transport artefact and an event is what the service actually produced.
    """
    from .sse import SSEParser

    started = time.monotonic()
    exchange = Exchange(
        request_id=f"req-{int(started * 1000) % 10_000_000:07d}",
        case_id="",
        method="POST",
        path=url,
    )
    parser = SSEParser()
    summary = {
        "events": 0,
        "invalid_events": 0,
        "done": False,
        "finish_reason": None,
        "generated": 0,
        "stopped_at": None,
    }

    def absorb(raw: bytes) -> bool:
        """Returns whether the caller should disconnect."""
        for event in parser.feed(raw):
            summary["events"] += 1
            if event.data == "[DONE]":
                summary["done"] = True
                continue
            try:
                body = json.loads(event.data)
            except json.JSONDecodeError:
                summary["invalid_events"] += 1
                continue
            choices = body.get("choices") if isinstance(body, dict) else None
            if not isinstance(choices, list) or not choices:
                continue
            choice = choices[0]
            if not isinstance(choice, dict):
                continue
            if choice.get("finish_reason"):
                summary["finish_reason"] = choice["finish_reason"]
            delta = choice.get("delta")
            if isinstance(delta, dict) and any(
                isinstance(delta.get(key), str) and delta[key]
                for key in ("content", "reasoning_content")
            ):
                summary["generated"] += 1
                if stop_after_tokens is not None and summary["generated"] >= stop_after_tokens:
                    summary["stopped_at"] = stop_after_tokens
                    return True
        return False

    try:
        async with session.post(url, json=payload, headers=headers) as response:
            exchange.status = response.status
            if response.status != 200:
                exchange.text = await response.text()
                exchange.latency_ms = round((time.monotonic() - started) * 1000, 3)
                return exchange, summary
            async for chunk in response.content.iter_any():
                if absorb(chunk):
                    break
            if stop_after_tokens is None:
                for event in parser.close():
                    summary["events"] += 1
                    if event.data == "[DONE]":
                        summary["done"] = True
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        exchange.error = f"{type(exc).__name__}: {exc}"
    exchange.latency_ms = round((time.monotonic() - started) * 1000, 3)
    return exchange, summary


# --- validation cases -------------------------------------------------------


async def _rejection_case(
    session: aiohttp.ClientSession,
    facts: TargetFacts,
    *,
    api_key: str | None,
    case_id: str,
    payload: dict | None = None,
    raw_body: str | None = None,
) -> CaseOutcome:
    """A malformed request must be refused *usefully*.

    Accepting it, crashing on it, or dropping the connection are all failures:
    a client cannot tell a service that tolerates nonsense from one that is
    simply broken.
    """
    exchange = await _request(
        session,
        "POST",
        f"{facts.base_url}/v1/chat/completions",
        headers=auth_headers(api_key),
        payload=payload,
        raw_body=raw_body,
    )
    exchange.case_id = case_id
    return _outcome(case_id, safe_rejection(exchange), exchange)


async def case_validation_malformed_json(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    return await _rejection_case(
        session, facts, api_key=api_key, case_id="validation.malformed_json", raw_body='{"model":'
    )


async def case_validation_missing_messages(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    payload = baseline_payload(facts)
    payload.pop("messages")
    return await _rejection_case(
        session, facts, api_key=api_key, case_id="validation.missing_messages", payload=payload
    )


async def case_validation_wrong_field_type(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    payload = {**baseline_payload(facts), "temperature": "hot"}
    return await _rejection_case(
        session, facts, api_key=api_key, case_id="validation.wrong_field_type", payload=payload
    )


async def case_output_small_limit(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """``max_tokens`` is a ceiling, not a suggestion."""
    payload = {**baseline_payload(facts), "max_tokens": 1}
    exchange = await _request(
        session,
        "POST",
        f"{facts.base_url}/v1/chat/completions",
        headers=auth_headers(api_key),
        payload=payload,
    )
    exchange.case_id = "output.small_limit"
    if exchange.error:
        return CaseOutcome("output.small_limit", True, ERROR, "inspector_error", exchange.error)
    if not valid_completion(exchange):
        return _outcome("output.small_limit", False, exchange)

    usage = exchange.body.get("usage") if isinstance(exchange.body, dict) else None
    produced = usage.get("completion_tokens") if isinstance(usage, dict) else None
    if isinstance(produced, int) and produced > 1:
        return CaseOutcome(
            "output.small_limit",
            True,
            FAIL,
            "assertion_failed",
            f"asked for 1 token, got {produced}",
        )
    return CaseOutcome("output.small_limit", True, PASS, "assertions_passed")


def context_overflow_applicable(facts: TargetFacts) -> bool:
    """Only meaningful when the context length is known and we can count tokens."""
    return facts.context_length is not None and facts.tokenizer_available


async def case_context_overflow(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """A request past the context window must be refused, not truncated.

    Truncating silently would mean a client asking a question about the end of
    a long document gets an answer about the beginning, and nothing says so.
    """
    payload = {
        "model": facts.model,
        "messages": [{"role": "user", "content": "x " * (facts.context_length + 64)}],
        "max_tokens": 1,
        "stream": False,
    }
    exchange = await _request(
        session,
        "POST",
        f"{facts.base_url}/v1/chat/completions",
        headers=auth_headers(api_key),
        payload=payload,
    )
    exchange.case_id = "context.overflow"
    return _outcome("context.overflow", safe_rejection(exchange), exchange)


# --- capability cases -------------------------------------------------------


async def case_extensions_tools(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """The tri-state rule, and the one that matters most.

    ``supported`` — the service said so, so a protocol error is a failure.
    ``unknown``  — probe, and read the answer conservatively.
    ``unsupported`` never happens today, but a service that says so is skipped.

    **A 5xx or a dropped connection is never "unsupported".** Reading a crash as
    a missing feature would turn the worst possible finding into a shrug.
    """
    case_id = "extensions.tools"
    required = facts.tools == SUPPORTED
    if facts.tools == UNSUPPORTED:
        return CaseOutcome(case_id, False, SKIPPED, "capability_unsupported")

    payload = {
        **baseline_payload(facts),
        "max_tokens": 128,
        "chat_template_kwargs": {"enable_thinking": False},
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "echo",
                    "description": "Echo a value back.",
                    "parameters": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                        "required": ["value"],
                    },
                },
            }
        ],
        "tool_choice": "required",
    }
    exchange = await _request(
        session,
        "POST",
        f"{facts.base_url}/v1/chat/completions",
        headers=auth_headers(api_key),
        payload=payload,
    )
    exchange.case_id = case_id

    if exchange.error:
        return CaseOutcome(case_id, required, ERROR, "inspector_error", exchange.error)
    if exchange.status and exchange.status >= 500:
        # The service broke. That is a failure whether or not it advertised
        # tools, and it must never be filed as "no tool support".
        return CaseOutcome(case_id, required, FAIL, "assertion_failed", f"HTTP {exchange.status}")
    if exchange.status and 400 <= exchange.status < 500:
        if required:
            return CaseOutcome(
                case_id, True, FAIL, "assertion_failed", f"declared tools but refused: {exchange.text[:200]}"
            )
        return CaseOutcome(case_id, False, SKIPPED, "capability_unsupported")
    if valid_tool_call(exchange):
        return CaseOutcome(case_id, required, PASS, "assertions_passed")
    if required:
        return CaseOutcome(case_id, True, FAIL, "assertion_failed", "no valid tool call came back")
    return CaseOutcome(case_id, False, INCONCLUSIVE, "capability_unknown", "tools did not work, but nothing declared them")


def valid_tool_call(exchange: Exchange) -> bool:
    if exchange.status != 200 or not isinstance(exchange.body, dict):
        return False
    choices = exchange.body.get("choices")
    if not isinstance(choices, list) or not choices:
        return False
    first = choices[0]
    if not isinstance(first, dict) or first.get("finish_reason") != "tool_calls":
        return False
    message = first.get("message")
    calls = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(calls, list) or not calls:
        return False
    function = calls[0].get("function") if isinstance(calls[0], dict) else None
    if not isinstance(function, dict) or function.get("name") != "echo":
        return False
    try:
        arguments = json.loads(function.get("arguments") or "")
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(arguments.get("value"), str)


def thinking_request(facts: TargetFacts, enabled: bool) -> dict:
    return {
        **baseline_payload(facts),
        "max_tokens": 64,
        "chat_template_kwargs": {"enable_thinking": enabled},
    }


async def case_extensions_thinking(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """The switch has to do something in both directions.

    A toggle that is accepted and ignored is worse than absent: callers pay for
    reasoning tokens they asked not to have, and nothing tells them.
    """
    case_id = "extensions.thinking"
    required = facts.thinking == SUPPORTED
    if facts.thinking == UNSUPPORTED:
        return CaseOutcome(case_id, False, SKIPPED, "capability_unsupported")

    url = f"{facts.base_url}/v1/chat/completions"
    headers = auth_headers(api_key)
    on = await _request(session, "POST", url, headers=headers, payload=thinking_request(facts, True))
    if on.error:
        return CaseOutcome(case_id, required, ERROR, "inspector_error", on.error)
    if on.status and on.status >= 500:
        return CaseOutcome(case_id, required, FAIL, "assertion_failed", f"HTTP {on.status} with thinking on")
    if on.status and 400 <= on.status < 500:
        if required:
            return CaseOutcome(case_id, True, FAIL, "assertion_failed", "declared thinking but refused it")
        return CaseOutcome(case_id, False, SKIPPED, "capability_unsupported")

    off = await _request(session, "POST", url, headers=headers, payload=thinking_request(facts, False))

    if not valid_completion(on) or not valid_completion(off):
        return CaseOutcome(case_id, required, FAIL, "assertion_failed", "a response was malformed")
    if not has_reasoning(on):
        # It answered, but not with reasoning: whether that is a failure depends
        # on whether the service ever claimed to reason.
        if required:
            return CaseOutcome(case_id, True, FAIL, "assertion_failed", "thinking on produced no reasoning_content")
        return CaseOutcome(case_id, False, INCONCLUSIVE, "capability_unknown", "the toggle had no visible effect")
    if has_reasoning(off):
        return CaseOutcome(case_id, True, FAIL, "assertion_failed", "thinking off still produced reasoning_content")
    return CaseOutcome(case_id, True, PASS, "assertions_passed")


# --- disruption -------------------------------------------------------------

ABORT_THRESHOLDS = (1, 16, 64)
STREAMS_PER_THRESHOLD = 8
SURVIVOR_STREAMS = 8
CANARY_REQUESTS = 4
RECOVERY_ROUNDS = 3
RECOVERY_DEADLINE_SECONDS = 30.0

LONG_GENERATION_PROMPT = "Repeat the word token. " * 16


async def case_disruption_abort_storm(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> CaseOutcome:
    """Abort many generations mid-flight while ordinary traffic is flowing.

    The question is isolation: does a client hanging up disturb the requests
    that did not? A service that couples them will show it here and nowhere
    else — every other case sends requests nobody interrupts.

    Disconnects are counted in **parsed content events**, never in bytes or
    chunks. A chunk boundary is a transport artefact; "the client left after
    the sixteenth token" is a statement about the generation, and only the
    parsed events can make it.

    Cancelled requests are deliberately **not** counted as service failures:
    a client withdrawing is the test working, not a fault.
    """
    case_id = "disruption.abort_storm"
    url = f"{facts.base_url}/v1/chat/completions"
    headers = auth_headers(api_key)

    def long_payload(max_tokens: int) -> dict:
        return {
            "model": facts.model,
            "messages": [{"role": "user", "content": LONG_GENERATION_PROMPT}],
            "max_tokens": max_tokens,
            # Without this the model stops when it decides it has answered, and
            # a stream that ends at sixteen tokens never reaches the sixty-fourth
            # — so the client never gets to withdraw there and the test quietly
            # stops testing what it says it tests.
            "ignore_eos": True,
            "temperature": 0,
            "stream": True,
        }

    jobs: list[tuple[str, int, Awaitable]] = []
    for threshold in ABORT_THRESHOLDS:
        for _ in range(STREAMS_PER_THRESHOLD):
            jobs.append(
                (
                    "abort",
                    threshold,
                    _stream_request(
                        session, url, headers=headers, payload=long_payload(2048),
                        stop_after_tokens=threshold,
                    ),
                )
            )
    for _ in range(SURVIVOR_STREAMS):
        jobs.append(
            ("survivor", 0, _stream_request(session, url, headers=headers, payload=long_payload(128)))
        )

    # Disruption first, canaries on top of it: the canaries are what makes this
    # a question about *other* traffic rather than about the aborted requests.
    running = [asyncio.create_task(job[2]) for job in jobs]
    await asyncio.sleep(0)
    canaries = [
        asyncio.create_task(
            _request(
                session, "POST", url, headers=headers, payload=baseline_payload(facts)
            )
        )
        for _ in range(CANARY_REQUESTS)
    ]
    results = await asyncio.gather(*running, *canaries)

    aborts = results[: len(jobs)]
    survivors = [result for job, result in zip(jobs, aborts) if job[0] == "survivor"]
    aborted = [result for job, result in zip(jobs, aborts) if job[0] == "abort"]
    canary_results = results[len(jobs):]

    bad_aborts = [
        (job[1], exchange, stream)
        for job, (exchange, stream) in zip(jobs, aborts)
        if job[0] == "abort" and not _aborted_correctly(exchange, stream, job[1])
    ]
    bad_survivors = [
        exchange for exchange, stream in survivors if not _stream_survived(exchange, stream)
    ]
    bad_canaries = [exchange for exchange in canary_results if not valid_completion(exchange)]

    if not bad_aborts and not bad_survivors and not bad_canaries:
        return CaseOutcome(case_id, True, PASS, "assertions_passed")

    detail = []
    if bad_aborts:
        detail.append(f"{len(bad_aborts)}/{len(aborted)} aborts went wrong")
    if bad_survivors:
        detail.append(f"{len(bad_survivors)}/{len(survivors)} survivors disturbed")
    if bad_canaries:
        detail.append(f"{len(bad_canaries)}/{len(canary_results)} canaries disturbed")
    return CaseOutcome(case_id, True, FAIL, "assertion_failed", "; ".join(detail))


def _aborted_correctly(exchange: Exchange, stream: dict, threshold: int) -> bool:
    """Did the client actually get to withdraw where it meant to?

    A stream that ended on its own before reaching the threshold means the
    abort never happened — the test asked for something the service finished
    first, which is a broken test rather than a broken service, and saying so
    is more useful than counting it either way.
    """
    if exchange.status != 200 or exchange.error:
        return False
    return stream["stopped_at"] == threshold and stream["generated"] >= threshold


def _stream_survived(exchange: Exchange, stream: dict) -> bool:
    if exchange.status != 200 or exchange.error:
        return False
    return (
        stream["done"]
        and stream["events"] > 0
        and stream["invalid_events"] == 0
        and stream["finish_reason"] in {"stop", "length", "tool_calls"}
    )


async def verify_recovery(
    session: aiohttp.ClientSession, facts: TargetFacts, *, api_key: str | None = None
) -> bool:
    """Did the service come back?

    Requires several consecutive clean rounds rather than one: a service that
    answers a single probe after an abort storm may simply have got lucky with
    what was still in flight.
    """
    headers = auth_headers(api_key)
    url = f"{facts.base_url}/v1/chat/completions"
    deadline = time.monotonic() + RECOVERY_DEADLINE_SECONDS
    consecutive = 0

    while time.monotonic() < deadline and consecutive < RECOVERY_ROUNDS:
        health, chat = await asyncio.gather(
            _request(session, "GET", f"{facts.base_url}{HEALTH_PATH}", headers=headers),
            _request(session, "POST", url, headers=headers, payload=baseline_payload(facts)),
        )
        # Concurrently, because a service that can only do one thing at a time
        # is not recovered.
        consecutive = consecutive + 1 if (health.status == 200 and valid_completion(chat)) else 0
        if consecutive >= RECOVERY_ROUNDS:
            return True
        await asyncio.sleep(0.5)
    return False


def has_reasoning(exchange: Exchange) -> bool:
    choices = exchange.body.get("choices") if isinstance(exchange.body, dict) else None
    if not isinstance(choices, list) or not choices:
        return False
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("reasoning_content") if isinstance(message, dict) else None
    return isinstance(content, str) and bool(content)


def baseline_payload(facts: TargetFacts) -> dict:
    """The smallest request that still proves the service generated something."""
    return {
        "model": facts.model,
        "messages": [{"role": "user", "content": "Reply with pong."}],
        "temperature": 0,
        "max_tokens": 16,
        "stream": False,
    }


def _outcome(case_id: str, passed: bool, exchange: Exchange, *, required: bool = True) -> CaseOutcome:
    if exchange.error:
        return CaseOutcome(
            case_id, required, ERROR, "inspector_error", exchange.error
        )
    if passed:
        return CaseOutcome(case_id, required, PASS, "assertions_passed")
    return CaseOutcome(
        case_id,
        required,
        FAIL,
        "assertion_failed",
        f"HTTP {exchange.status}: {exchange.text[:200]}",
    )


def catalogue() -> list[Case]:
    """Every case this suite version runs, in order.

    Cheapest and most fundamental first: a service that cannot answer a plain
    request should say so immediately rather than after a minute of probes.
    """
    return [
        # The service's own probes first: the cheapest way to learn it is up.
        Case("health.generate", case_health_generate),
        Case("completion.non_stream", case_completion_non_stream),
        Case("streaming.basic", case_streaming_basic),
        Case("validation.malformed_json", case_validation_malformed_json),
        Case("validation.missing_messages", case_validation_missing_messages),
        Case("validation.wrong_field_type", case_validation_wrong_field_type),
        Case("output.small_limit", case_output_small_limit),
        Case(
            "context.overflow",
            case_context_overflow,
            applicable=context_overflow_applicable,
            # A context-length prompt is megabytes of JSON, and the service has
            # to tokenise it before it can refuse it.
            timeout_seconds=240.0,
        ),
        # Capability cases: their own verdict carries whether they were
        # required, which depends on what the service advertised.
        Case("extensions.tools", case_extensions_tools, required=False),
        Case("extensions.thinking", case_extensions_thinking, required=False),
        # Last, and the only disruptive one: it aborts generations on purpose,
        # so anything after it would be measuring the aftermath.
        Case(
            "disruption.abort_storm",
            case_disruption_abort_storm,
            timeout_seconds=180.0,
            recovery_required=True,
            disruptive=True,
        ),
    ]


# --- running ----------------------------------------------------------------


def aggregate(cases: list[CaseOutcome]) -> str:
    """The Run's verdict, from the cases'.

    Only required cases move it. A capability the service never claimed cannot
    fail it, and an optional case that went wrong is worth reporting without
    being worth a red light.
    """
    required = [case for case in cases if case.required]
    if any(case.verdict in (FAIL, ERROR) for case in required):
        return FAIL
    if any(case.verdict == INCONCLUSIVE for case in required):
        return INCONCLUSIVE
    return PASS


EventSink = Callable[[dict], None]


async def run_inspection(
    base_url: str,
    *,
    api_key: str | None = None,
    on_event: EventSink | None = None,
) -> RunSummary:
    """Inspect one service. Never raises for a service's behaviour — only a
    failed discovery is fatal, because nothing can be judged without it."""
    summary = RunSummary(suite_version=SUITE_VERSION, target=None)

    def emit(event: dict) -> None:
        if on_event is not None:
            on_event(event)

    try:
        facts, _ = await discover(base_url, api_key=api_key)
    except DiscoveryError as exc:
        summary.run_verdict = FAIL
        summary.cases.append(
            CaseOutcome("discovery", True, FAIL, "discovery_failed", str(exc))
        )
        emit({"type": "discovery_failed", "message": str(exc)})
        return summary
    summary.target = facts
    emit({"type": "discovered", "target": facts.as_dict()})

    timeout = aiohttp.ClientTimeout(total=CASE_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        run_unsafe = False
        for case in catalogue():
            if run_unsafe and case.disruptive:
                summary.cases.append(CaseOutcome(case.case_id, case.required, SKIPPED, "run_unsafe"))
                continue
            if case.applicable is not None and not case.applicable(facts):
                summary.cases.append(CaseOutcome(case.case_id, False, SKIPPED, "not_applicable"))
                continue
            emit({"type": "case_started", "case_id": case.case_id})
            try:
                outcome = await asyncio.wait_for(
                    case.run(session, facts, api_key=api_key), timeout=case.timeout_seconds
                )
            except asyncio.TimeoutError:
                outcome = CaseOutcome(
                    case.case_id, case.required, ERROR, "case_deadline", "case timed out"
                )
            except Exception as exc:  # noqa: BLE001 — a broken inspector is not a broken service
                outcome = CaseOutcome(
                    case.case_id,
                    case.required,
                    ERROR,
                    "inspector_error",
                    f"{type(exc).__name__}: {exc}",
                )

            if case.recovery_required and outcome.verdict == PASS:
                # The case says the disruption was handled; recovery says the
                # service is still usable afterwards. Both have to hold.
                if not await verify_recovery(session, facts, api_key=api_key):
                    outcome = CaseOutcome(
                        case.case_id,
                        outcome.required,
                        FAIL,
                        "recovery_failed",
                        "the service did not come back after the disruption",
                    )
                    run_unsafe = True

            summary.cases.append(outcome)
            emit({"type": "case_finished", "case_id": case.case_id, "verdict": outcome.verdict})

    summary.run_verdict = aggregate(summary.cases)
    emit({"type": "run_finished", "verdict": summary.run_verdict})
    return summary
