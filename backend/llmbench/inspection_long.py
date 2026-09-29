"""Opt-in long-sequence probes. Token budgets are verified before generation."""

import json

from . import inspection as i


def outcome(case_id, verdict, reason, target, actual=None, detail=""):
    measured = "未知" if actual is None else str(actual)
    return i.CaseOutcome(case_id, True, verdict, reason,
                         f"目标 {target} token（90% 上下文）；实际 {measured} token。{detail}")


def prerequisites(case_id, facts):
    if not facts.context_length or not facts.tokenizer_available:
        return outcome(case_id, i.SKIPPED, "length_prerequisites_missing", "未知",
                       detail="需要上下文上限和可用的消息 tokenizer。")
    return None


async def count_input(session, facts, messages, api_key):
    exchange = await i._request(session, "POST", f"{facts.base_url}/v1/tokenize",
        headers=i.auth_headers(api_key), payload={"model": facts.model, "messages": messages})
    count = i._positive_int(exchange.body.get("count")) if isinstance(exchange.body, dict) else None
    return exchange, count if exchange.status == 200 else None


def request_problem(case_id, exchange, target, actual=None):
    if exchange.error:
        return outcome(case_id, i.ERROR, "inspector_error", target, actual, exchange.error)
    if exchange.status and exchange.status >= 500:
        return outcome(case_id, i.FAIL, "server_error", target, actual, f"HTTP {exchange.status}")
    if exchange.status != 200:
        return outcome(case_id, i.INCONCLUSIVE, "request_rejected", target, actual,
                       f"HTTP {exchange.status}：{exchange.text}")
    return None


async def case_long_input(session, facts, *, api_key=None):
    case_id = "context.long_input"
    if missing := prerequisites(case_id, facts):
        return missing
    target = facts.context_length * 9 // 10
    reserve = min(64, facts.context_length - target)
    if target < 1 or reserve < 1:
        return outcome(case_id, i.INCONCLUSIVE, "budget_unavailable", target)
    # Search a bounded set of candidate lengths, counting the complete message
    # including its chat template. Do not trust a characters-to-tokens estimate.
    low, high = 0, max(1, target * 2)
    tolerance = max(1, facts.context_length // 1000)
    best = None
    actual = None
    for _ in range(24):
        repeats = (low + high) // 2
        messages = [{"role": "user", "content":
            "Read the following data and reply briefly with OK.\n" + "sample " * repeats}]
        counted, actual = await count_input(session, facts, messages, api_key)
        if problem := request_problem(case_id, counted, target, actual):
            return problem
        if actual is None:
            return outcome(case_id, i.INCONCLUSIVE, "token_count_unavailable", target)
        if target <= actual <= target + tolerance and actual + reserve <= facts.context_length:
            best = messages
            break
        if actual < target:
            low = repeats + 1
        else:
            high = repeats - 1
        if low > high:
            break
    if best is None:
        return outcome(case_id, i.INCONCLUSIVE, "input_target_unreached", target, actual,
                       "无法在允许误差内构造 90% 长输入；未发送生成请求。")
    exchange = await i._request(session, "POST", f"{facts.base_url}/v1/chat/completions",
        headers=i.auth_headers(api_key), payload={
            "model": facts.model, "messages": best, "max_tokens": reserve, "stream": False})
    if exchange.status in {400, 422} and i.safe_rejection(exchange):
        detail = json.dumps(exchange.body).lower()
        if any(word in detail for word in ("context", "max_model_len", "context_length")):
            return outcome(case_id, i.FAIL, "in_budget_input_rejected", target, actual,
                           "tokenizer 已确认预算未越界，但生成接口拒绝上下文长度。")
    if problem := request_problem(case_id, exchange, target, actual):
        return problem
    valid = i.valid_completion(exchange)
    if valid:
        choice = exchange.body["choices"][0]
        if choice["finish_reason"] == "length":
            return outcome(case_id, i.INCONCLUSIVE, "reply_truncated", target, actual,
                           "短回复耗尽预留输出预算，无法确认完整回复。")
        content = choice["message"].get("content")
        valid = (choice["finish_reason"] == "stop"
                 and isinstance(content, str) and bool(content.strip()))
    return outcome(case_id, i.PASS if valid else i.FAIL, "assertions_passed" if valid else "invalid_completion",
                   target, actual, f"预留输出 {reserve} token。")


async def case_long_output(session, facts, *, api_key=None):
    case_id = "output.long_generation"
    if missing := prerequisites(case_id, facts):
        return missing
    target = facts.context_length * 9 // 10
    if target < 1:
        return outcome(case_id, i.INCONCLUSIVE, "budget_unavailable", target)
    if facts.max_output_tokens and facts.max_output_tokens < target:
        return outcome(case_id, i.INCONCLUSIVE, "output_limit_below_target", target,
                       detail=f"服务输出上限 {facts.max_output_tokens}，不降低目标。")
    messages = [{"role": "user", "content":
        "Write a very long detailed numbered list of facts about mathematics. "
        "Keep adding new entries until the output token limit is reached."}]
    counted, input_count = await count_input(session, facts, messages, api_key)
    if problem := request_problem(case_id, counted, target):
        return problem
    if input_count is None or input_count + target > facts.context_length:
        return outcome(case_id, i.INCONCLUSIVE, "budget_unavailable", target,
                       detail=f"短输入计数 {input_count}；无法确认输入加目标输出在上下文内。")
    payload = {"model": facts.model, "messages": messages, "stream": True,
               "max_tokens": target, "stream_options": {"include_usage": True}}
    exchange, stream = await i._stream_request(session, f"{facts.base_url}/v1/chat/completions",
        headers=i.auth_headers(api_key), payload=payload)
    usage = stream.get("usage")
    actual = usage.get("completion_tokens") if isinstance(usage, dict) else None
    if type(actual) is not int or actual < 0:
        actual = None
    if problem := request_problem(case_id, exchange, target, actual):
        return problem
    if (stream["invalid_events"] or not stream["events"] or not stream.get("generated") or not stream["done"]
            or stream["finish_reason"] not in {"stop", "length"}):
        return outcome(case_id, i.FAIL, "invalid_stream", target, actual,
                       "流式数据损坏或缺少正常结束标记。")
    if actual is None:
        return outcome(case_id, i.INCONCLUSIVE, "token_count_unavailable", target,
                       detail="缺少可靠的 completion_tokens，不能证明覆盖目标长度。")
    if actual > target:
        return outcome(case_id, i.FAIL, "output_limit_exceeded", target, actual)
    if actual < target:
        return outcome(case_id, i.INCONCLUSIVE, "output_target_unreached", target, actual,
                       f"提前结束，finish_reason={stream['finish_reason']}。")
    return outcome(case_id, i.PASS, "assertions_passed", target, actual,
                   f"输入 {input_count} token；finish_reason={stream['finish_reason']}。")
