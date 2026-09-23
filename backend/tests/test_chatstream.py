"""The stream reader, tested against the shape a live SGLang server actually sends.

Every test in this file corresponds to a trap that fails *silently*: the run
completes, the numbers look plausible, and they are wrong. These fixtures are
verbatim payloads captured from the target service.
"""

from __future__ import annotations

import json

import pytest

from llmbench.chatstream import StreamReader

# --- real payloads, captured from the target service -------------------------

CHAT_ROLE_ONLY = {
    "choices": [
        {
            "index": 0,
            "delta": {"reasoning_content": None, "role": "assistant", "content": ""},
            "logprobs": None,
            "finish_reason": None,
            "matched_stop": None,
        }
    ]
}
CHAT_TOKEN_P = {
    "choices": [
        {"index": 0, "delta": {"reasoning_content": None, "content": "p"}, "finish_reason": None}
    ],
    "usage": {
        "prompt_tokens": 9,
        "total_tokens": 10,
        "completion_tokens": 1,
        "prompt_tokens_details": None,
        "reasoning_tokens": 0,
    },
}
CHAT_TOKEN_ONG = {
    "choices": [
        {"index": 0, "delta": {"reasoning_content": None, "content": "ong"}, "finish_reason": None}
    ],
    "usage": {
        "prompt_tokens": 9,
        "total_tokens": 11,
        "completion_tokens": 2,
        "prompt_tokens_details": None,
        "reasoning_tokens": 0,
    },
}
CHAT_STOP = {
    "choices": [
        {
            "index": 0,
            "delta": {"reasoning_content": None},
            "logprobs": None,
            "finish_reason": "stop",
            "matched_stop": 1,
        }
    ]
}
CHAT_FINAL_USAGE = {
    "choices": [],
    "usage": {"prompt_tokens": 9, "total_tokens": 12, "completion_tokens": 3, "reasoning_tokens": 0},
}

COMPLETION_TEXT_I = {
    "choices": [{"index": 0, "text": "I", "finish_reason": None}],
    "usage": {"prompt_tokens": 7, "total_tokens": 8, "completion_tokens": 1},
}
COMPLETION_FINAL_USAGE = {
    "choices": [],
    "usage": {"prompt_tokens": 7, "total_tokens": 11, "completion_tokens": 4, "reasoning_tokens": 0},
}


def stream_bytes(*payloads: object) -> bytes:
    """JSON-encode dict payloads; pass bytes through raw so `[DONE]` stays literal."""
    parts = []
    for payload in payloads:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        parts.append(b"data: " + body + b"\n\n")
    return b"".join(parts)


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance_ms(self, milliseconds: float) -> None:
        self.now += milliseconds / 1000.0


def read(stream: bytes, clock: FakeClock | None = None) -> StreamReader:
    clock = clock or FakeClock()
    reader = StreamReader(started_at=clock(), clock=clock)
    reader.feed(stream)
    reader.finish()
    return reader


# --- the traps ---------------------------------------------------------------


def test_trap_1_usage_is_cumulative_so_last_wins():
    reader = read(stream_bytes(CHAT_TOKEN_P, CHAT_TOKEN_ONG, CHAT_FINAL_USAGE, b"[DONE]"))
    assert reader.observation.completion_tokens == 3  # not 1 + 2 + 3 = 6
    assert reader.observation.prompt_tokens == 9


def test_trap_2_empty_choices_on_the_final_usage_event_does_not_crash():
    reader = read(stream_bytes(CHAT_FINAL_USAGE, b"[DONE]"))
    assert reader.observation.completion_tokens == 3
    assert reader.observation.malformed_events == 0


def test_trap_3_null_reasoning_content_does_not_start_the_clock():
    clock = FakeClock()
    reader = StreamReader(started_at=clock(), clock=clock)
    reader.feed(stream_bytes(CHAT_ROLE_ONLY))
    assert reader.observation.ttft_ms is None


def test_trap_4_empty_content_does_not_start_the_clock():
    clock = FakeClock()
    reader = StreamReader(started_at=clock(), clock=clock)
    reader.feed(stream_bytes(CHAT_ROLE_ONLY))
    assert reader.observation.ttft_ms is None

    clock.advance_ms(40)
    reader.feed(stream_bytes(CHAT_TOKEN_P))
    assert reader.observation.ttft_ms == pytest.approx(40.0)


def test_trap_5_null_prompt_token_details_is_unknown_not_zero():
    reader = read(stream_bytes(CHAT_TOKEN_P, CHAT_FINAL_USAGE, b"[DONE]"))
    assert reader.observation.cached_tokens is None
    assert not reader.observation.cached_tokens


def test_trap_6_finish_reason_arrives_without_a_content_key():
    reader = read(stream_bytes(CHAT_TOKEN_P, CHAT_STOP, CHAT_FINAL_USAGE, b"[DONE]"))
    assert reader.observation.finish_reason == "stop"
    assert reader.observation.text_events == 1


def test_trap_7_final_usage_event_omits_prompt_tokens_details_entirely():
    """Its schema differs from the per-chunk usage events."""
    assert "prompt_tokens_details" not in CHAT_FINAL_USAGE["usage"]
    reader = read(stream_bytes(CHAT_TOKEN_P, CHAT_FINAL_USAGE, b"[DONE]"))
    assert reader.observation.completion_tokens == 3


# --- other behaviour ---------------------------------------------------------


def test_completions_endpoint_text_field_is_a_token():
    clock = FakeClock()
    reader = StreamReader(started_at=clock(), clock=clock)
    reader.feed(stream_bytes(COMPLETION_TEXT_I))
    assert reader.observation.ttft_ms == pytest.approx(0.0)
    assert reader.observation.text_events == 1


def test_reasoning_content_with_real_text_is_a_token():
    """The model reasons before answering; that output is still output."""
    clock = FakeClock()
    reader = StreamReader(started_at=clock(), clock=clock)
    payload = {"choices": [{"index": 0, "delta": {"reasoning_content": "think"}, "finish_reason": None}]}
    reader.feed(stream_bytes(payload))
    assert reader.observation.ttft_ms == pytest.approx(0.0)


def test_done_sentinel_is_not_parsed_as_json():
    reader = read(stream_bytes(CHAT_TOKEN_P, b"[DONE]"))
    assert reader.observation.saw_done
    assert reader.observation.malformed_events == 0


def test_a_stream_without_done_is_visible_to_the_caller():
    reader = read(stream_bytes(CHAT_TOKEN_P, CHAT_FINAL_USAGE))
    assert not reader.observation.saw_done


def test_malformed_json_is_counted_not_raised():
    clock = FakeClock()
    reader = StreamReader(started_at=clock(), clock=clock)
    reader.feed(b"data: {not json\n\ndata: [1,2,3]\n\n")
    assert reader.observation.malformed_events == 2


def test_cached_tokens_take_the_high_water_mark():
    reader = read(stream_bytes(CHAT_TOKEN_P, CHAT_FINAL_USAGE, b"[DONE]"))
    reader2 = StreamReader(started_at=1000.0, clock=lambda: 1000.0)
    with_details = {
        "choices": [],
        "usage": {
            "prompt_tokens": 9,
            "completion_tokens": 3,
            "prompt_tokens_details": {"cached_tokens": 256},
        },
    }
    reader2.feed(stream_bytes(with_details))
    reader2.finish()
    assert reader2.observation.cached_tokens == 256
    assert reader.observation.cached_tokens is None


def test_cached_tokens_fall_back_to_the_device_host_split():
    reader = StreamReader(started_at=1000.0, clock=lambda: 1000.0)
    payload = {"choices": [], "usage": {"cached_tokens_device": 64, "cached_tokens_host": 32}}
    reader.feed(stream_bytes(payload))
    reader.finish()
    assert reader.observation.cached_tokens == 96


def test_ttft_is_measured_from_the_caller_supplied_start():
    clock = FakeClock(start=500.0)
    reader = StreamReader(started_at=clock(), clock=clock)
    clock.advance_ms(125)
    reader.feed(stream_bytes(CHAT_TOKEN_P))
    assert reader.observation.ttft_ms == pytest.approx(125.0)
