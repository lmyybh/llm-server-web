"""Interpret an OpenAI-compatible SSE stream into what a measurement needs.

Written against the shape the target server *actually* sends, not the shape
the docs describe. Every guard below corresponds to a trap observed on a live
SGLang endpoint:

1. ``usage`` rides on every chunk and is **cumulative** — last-wins, never sum.
2. The final usage event carries ``choices: []``.
3. Every delta carries ``reasoning_content: null``.
4. The first chat chunk carries ``content: ""``.
5. ``prompt_tokens_details`` is ``null`` even when explicitly requested.
6. ``finish_reason`` arrives on a delta that has no ``content`` key at all.
7. The final usage event **omits** ``prompt_tokens_details`` entirely, so its
   schema differs from the per-chunk ones.

Each of these fails silently — the run completes and the numbers are wrong.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass

from .sse import SSEEvent, SSEParser

DONE_SENTINEL = "[DONE]"


@dataclass
class StreamObservation:
    """Everything one streamed response tells us about itself."""

    ttft_ms: float | None = None
    finish_reason: str | None = None
    saw_done: bool = False
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cached_tokens: int | None = None
    text_events: int = 0
    usage_events: int = 0
    malformed_events: int = 0


class StreamReader:
    """Feed raw bytes; read the observation when the stream ends.

    ``started_at`` is a monotonic timestamp taken when the request was actually
    sent — TTFT is measured from there, so time spent waiting for a concurrency
    slot is excluded by construction.
    """

    def __init__(
        self,
        started_at: float,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self._started_at = started_at
        self._clock = clock
        self._parser = SSEParser()
        self.observation = StreamObservation()

    def feed(self, chunk: bytes) -> None:
        for event in self._parser.feed(chunk):
            self._absorb(event)

    def finish(self) -> StreamObservation:
        for event in self._parser.close():
            self._absorb(event)
        return self.observation

    def _absorb(self, event: SSEEvent) -> None:
        if event.data == DONE_SENTINEL:
            self.observation.saw_done = True
            return
        try:
            payload = json.loads(event.data)
        except json.JSONDecodeError:
            self.observation.malformed_events += 1
            return
        if not isinstance(payload, dict):
            self.observation.malformed_events += 1
            return
        self._absorb_usage(payload.get("usage"))
        self._absorb_choices(payload.get("choices"))

    def _absorb_usage(self, usage: object) -> None:
        if not isinstance(usage, dict):
            return
        self.observation.usage_events += 1

        # Trap 1: cumulative, repeated on every chunk. Last-wins.
        prompt_tokens = usage.get("prompt_tokens")
        if isinstance(prompt_tokens, int):
            self.observation.prompt_tokens = prompt_tokens
        completion_tokens = usage.get("completion_tokens")
        if isinstance(completion_tokens, int):
            self.observation.completion_tokens = completion_tokens

        # Trap 5 & 7: null, and absent entirely on the last event. A high-water
        # mark keeps an earlier real reading when the final event omits it, and
        # never turns "unknown" into zero.
        cached = _cached_tokens(usage)
        if cached is not None:
            self.observation.cached_tokens = max(self.observation.cached_tokens or 0, cached)

    def _absorb_choices(self, choices: object) -> None:
        # Trap 2: the final usage event sends an empty list.
        if not isinstance(choices, list) or not choices:
            return
        choice = choices[0]
        if not isinstance(choice, dict):
            self.observation.malformed_events += 1
            return

        # Trap 6: finish_reason rides on a delta with no content key.
        finish_reason = choice.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason:
            self.observation.finish_reason = finish_reason

        if _carries_text(choice):
            self.observation.text_events += 1
            if self.observation.ttft_ms is None:
                self.observation.ttft_ms = (self._clock() - self._started_at) * 1000.0


def _carries_text(choice: dict) -> bool:
    """Is this choice a *token*, as opposed to a protocol marker?

    Traps 3 & 4 live here: ``reasoning_content`` is present-but-null on every
    chunk, and ``content`` is an empty string on the first chat chunk. Testing
    for key presence would fire TTFT on both.
    """
    delta = choice.get("delta")
    if isinstance(delta, dict):
        for key in ("content", "reasoning_content"):
            value = delta.get(key)
            if isinstance(value, str) and value:
                return True
        return bool(delta.get("tool_calls"))
    text = choice.get("text")  # /v1/completions
    return isinstance(text, str) and bool(text)


def _cached_tokens(usage: dict) -> int | None:
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        cached = details.get("cached_tokens")
        if isinstance(cached, int):
            return cached
    device = usage.get("cached_tokens_device")
    host = usage.get("cached_tokens_host")
    if isinstance(device, int) or isinstance(host, int):
        return (device if isinstance(device, int) else 0) + (host if isinstance(host, int) else 0)
    return None
