"""Opt-in sustained load with measured coverage and bounded evidence."""

import asyncio
from collections import Counter
import hashlib
import json
import random
import secrets
import time

from . import inspection as i
from .inspection_long import count_input

CASE_ID = "stability.high_concurrency"
INPUT_TOKENS = 100 * 1024
OUTPUT_TOKENS = 2 * 1024
CONCURRENCY = 64
DURATION_SECONDS = 300
REQUEST_TIMEOUT = 180
PREPARE_TIMEOUT = 240
RECOVERY_TIMEOUT = 60
TOKENIZER_CONCURRENCY = 4


class PreparationError(Exception):
    def __init__(self, message, verdict=i.INCONCLUSIVE):
        super().__init__(message)
        self.verdict = verdict


async def prepare_payload(session, facts, api_key):
    """Fresh random prefix and body on every request, counted as chat messages."""
    rng = random.Random(secrets.randbits(128))
    # Hex digits have no useful language structure and vary from the first byte.
    data = "".join(rng.choices("0123456789abcdef ", k=INPUT_TOKENS * 4))
    low, high = 1, len(data)
    length = INPUT_TOKENS * 2
    tolerance = max(1, INPUT_TOKENS // 1000)
    for _ in range(24):
        messages = [{"role": "user", "content": data[:length] +
            "\nContinue generating a detailed numbered list until the output limit."}]
        counted, actual = await count_input(session, facts, messages, api_key)
        if counted.error:
            raise PreparationError(counted.error, i.ERROR)
        if counted.status and counted.status >= 500:
            raise PreparationError(f"tokenizer HTTP {counted.status}", i.FAIL)
        if counted.status != 200 or actual is None:
            raise PreparationError("tokenizer 未提供可靠计数，无法校准 100K 输入。")
        if INPUT_TOKENS <= actual <= INPUT_TOKENS + tolerance and actual + OUTPUT_TOKENS <= facts.context_length:
            payload = {"model": facts.model, "messages": messages, "stream": True,
                       "max_tokens": OUTPUT_TOKENS, "ignore_eos": True,
                       "stream_options": {"include_usage": True}}
            return payload, actual, hashlib.sha256(messages[0]["content"].encode()).hexdigest()
        if actual < INPUT_TOKENS:
            low = length + 1
        else:
            high = length - 1
        if low > high:
            break
        length = (low + high) // 2
    raise PreparationError("随机输入无法校准到 100K token；未降低负载。")


def classify(exchange, stream):
    if exchange.error:
        return "connection_error", None, None
    if exchange.status == 429:
        return "rate_limited", None, None
    if exchange.status and exchange.status >= 500:
        return "server_error", None, None
    if exchange.status != 200:
        return "rejected", None, None
    if (stream.get("invalid_events") or not stream.get("done") or not stream.get("generated")
            or stream.get("finish_reason") not in {"stop", "length"}):
        return "invalid_stream", None, None
    usage = stream.get("usage") or {}
    input_count, output_count = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if type(input_count) is not int or type(output_count) is not int or min(input_count, output_count) < 0:
        return "unmeasured", None, None
    if output_count > OUTPUT_TOKENS:
        return "output_over_limit", input_count, output_count
    if input_count < INPUT_TOKENS or output_count < OUTPUT_TOKENS:
        return "under_target", input_count, output_count
    return "success", input_count, output_count


async def case_high_concurrency(session, facts, *, api_key=None):
    def result(verdict, reason, message):
        return i.CaseOutcome(CASE_ID, True, verdict, reason, message)

    if not facts.context_length or not facts.tokenizer_available:
        return result(i.SKIPPED, "load_prerequisites_missing", "需要可靠上下文上限和消息 tokenizer。")
    if facts.context_length < INPUT_TOKENS + OUTPUT_TOKENS:
        return result(i.INCONCLUSIVE, "load_budget_unavailable", "上下文不足 104448 token，无法覆盖 100K 输入＋2K 输出，不降低负载。")
    if facts.max_output_tokens and facts.max_output_tokens < OUTPUT_TOKENS:
        return result(i.INCONCLUSIVE, "load_budget_unavailable", "独立输出上限不足 2K，不降低负载。")

    # Baseline is independent of the load and kept as ordinary evidence.
    health = await i._request(session, "GET", f"{facts.base_url}{i.HEALTH_PATH}", headers=i.auth_headers(api_key))
    if health.error or health.status != 200:
        return result(i.INCONCLUSIVE, "baseline_not_ready", "加压前健康检查未通过，未发送压力请求。")
    chat = await i.case_completion_non_stream(session, facts, api_key=api_key)
    stream_check = await i.case_streaming_basic(session, facts, api_key=api_key)
    if chat.verdict != i.PASS or stream_check.verdict != i.PASS:
        return result(i.INCONCLUSIVE, "baseline_not_ready", "加压前普通或流式检查未通过，未发送压力请求。")

    # Bulk inputs can be hundreds of MB. Persist counts, hashes and bounded
    # failure samples instead of duplicating every random request in SQLite.
    sink_token = i._evidence_sink.set(None)
    counters = Counter()
    records = []
    tasks = []
    preparation_tasks = set()
    active = peak = 0
    area = 0.0
    last_change = start = deadline = None
    recovery = "未执行"
    completed_window = False
    preparation_failure = None
    stop = asyncio.Event()
    semaphore = asyncio.Semaphore(TOKENIZER_CONCURRENCY)

    async def prepare():
        async with semaphore:
            async with asyncio.timeout(REQUEST_TIMEOUT):
                return await prepare_payload(session, facts, api_key)

    def schedule_prepare():
        task = asyncio.create_task(prepare())
        preparation_tasks.add(task)
        task.add_done_callback(preparation_tasks.discard)
        return task

    def change_active(delta):
        nonlocal active, peak, area, last_change
        now = time.monotonic()
        if last_change is not None:
            area += active * max(0, min(now, deadline) - min(last_change, deadline))
        active += delta
        peak = max(peak, active)
        last_change = now

    async def worker(prepared):
        nonlocal preparation_failure
        while time.monotonic() < deadline and not stop.is_set():
            payload, calibrated, digest = prepared
            # Prepare the next independent random request while this one runs.
            following = schedule_prepare()
            counters["started"] += 1
            change_active(1)
            began = time.monotonic()
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT):
                    exchange, summary = await i._stream_request(session,
                        f"{facts.base_url}/v1/chat/completions",
                        headers=i.auth_headers(api_key), payload=payload)
                category, measured_input, measured_output = classify(exchange, summary)
                error = exchange.error or (exchange.text[:1200] if category != "success" else "")
            except TimeoutError:
                category, measured_input, measured_output, error = "timeout", None, None, "请求超过 180 秒"
            except asyncio.CancelledError:
                counters["cancelled"] += 1
                following.cancel()
                await asyncio.gather(following, return_exceptions=True)
                raise
            finally:
                change_active(-1)
            counters[category] += 1
            counters["finished"] += 1
            if len(records) < 128 or (category != "success" and len(records) < 160):
                records.append({"input_sha256": digest, "calibrated_input_tokens": calibrated,
                    "prompt_tokens": measured_input, "completion_tokens": measured_output,
                    "result": category, "duration_seconds": round(time.monotonic() - began, 3),
                    "error": error})
            # Do not hammer a rejecting/unhealthy target with rapid retries.
            if category in {"server_error", "invalid_stream", "output_over_limit", "rejected", "rate_limited", "connection_error", "timeout"}:
                stop.set()
            if stop.is_set() or time.monotonic() >= deadline:
                following.cancel()
                await asyncio.gather(following, return_exceptions=True)
                break
            try:
                done, _ = await asyncio.wait({following}, timeout=max(0, deadline - time.monotonic()))
                if not done:
                    following.cancel()
                    await asyncio.gather(following, return_exceptions=True)
                    break
                prepared = await following
            except (PreparationError, TimeoutError) as exc:
                preparation_failure = exc
                stop.set()
                break

    try:
        initial_tasks = [schedule_prepare() for _ in range(CONCURRENCY)]
        async with asyncio.timeout(PREPARE_TIMEOUT):
            prepared = await asyncio.gather(*initial_tasks)
        start = last_change = time.monotonic()
        deadline = start + DURATION_SECONDS
        tasks = [asyncio.create_task(worker(item)) for item in prepared]
        await asyncio.gather(*tasks)
        completed_window = time.monotonic() >= deadline and not stop.is_set()
    except (PreparationError, TimeoutError) as exc:
        preparation_failure = exc
    finally:
        # Also runs on the enclosing case's deadline and task cancellation.
        for task in [*tasks, *preparation_tasks]:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, *preparation_tasks, return_exceptions=True)
        i._evidence_sink.reset(sink_token)
        if counters["started"]:
            try:
                recovered = await i.verify_recovery(session, facts, api_key=api_key,
                                                    timeout_seconds=RECOVERY_TIMEOUT)
                recovery = "通过" if recovered else "失败"
            except Exception as exc:
                recovery = f"执行出错：{exc}"
        average = area / DURATION_SECONDS if start is not None else 0
        metrics = {"configuration": {"input_tokens": INPUT_TOKENS, "output_tokens": OUTPUT_TOKENS,
            "concurrency": CONCURRENCY, "duration_seconds": DURATION_SECONDS, "ignore_eos": True},
            "completed_window": completed_window, "peak_in_flight": peak,
            "average_in_flight": round(average, 2), "counts": dict(counters),
            "recovery": recovery, "preparation_error": str(preparation_failure) if preparation_failure else None,
            "samples": records, "samples_truncated": counters["finished"] > len(records)}
        i._record_exchange(i.Exchange("", CASE_ID, "SUMMARY", facts.base_url,
            text=json.dumps(metrics, ensure_ascii=False)), None, auth=False)

    message = (f"100K 输入 / 2K 输出，64 并发；发起 {counters['started']}，完成 {counters['finished']}，"
        f"达标 {counters['success']}，限流 {counters['rate_limited']}，5xx {counters['server_error']}，"
        f"超时 {counters['timeout']}，连接错误 {counters['connection_error']}，断流/格式错误 {counters['invalid_stream']}；"
        f"峰值并发 {peak}，窗口平均并发 {average:.1f}；恢复：{recovery}。")
    if counters["server_error"] or counters["invalid_stream"] or counters["output_over_limit"] or recovery == "失败":
        return result(i.FAIL, "load_failure", message)
    if counters["timeout"] or counters["connection_error"] or recovery.startswith("执行出错"):
        return result(i.ERROR, "load_execution_error", message)
    if preparation_failure:
        verdict = preparation_failure.verdict if isinstance(preparation_failure, PreparationError) else i.ERROR
        return result(verdict, "load_preparation_failed", message + str(preparation_failure))
    coverage = counters["success"] / counters["finished"] if counters["finished"] else 0
    if not completed_window or peak < CONCURRENCY or average < CONCURRENCY * .9 or coverage < .9:
        return result(i.INCONCLUSIVE, "load_coverage_insufficient", message + "未覆盖完整持续时间、实际并发或 token 负载。")
    return result(i.PASS, "assertions_passed", message)
