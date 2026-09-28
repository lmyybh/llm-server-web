"""Closed-loop load generation against a Target Service.

Runs a bounded number of requests at a fixed concurrency and reports what
happened. Timing starts when the request is actually issued, so time spent
waiting for a concurrency slot is excluded from TTFT and E2E — the numbers are
*service time*, not the latency a client behind a queue would feel.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import aiohttp
import numpy as np

from .chatstream import StreamReader
from .metrics import (
    E2E_BUCKETS_MS,
    TPOT_BUCKETS_MS,
    TTFT_BUCKETS_MS,
    Histogram,
    percentile,
    tpot_ms,
)

COMPLETIONS_PATH = "/v1/completions"
CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
"""Synthetic shapes are raw token ids, so they go through the completions API;
business payloads are message lists, so they go through chat."""

FLUSH_PATH = "/flush_cache"
RANDOM_TOKEN_UPPER_BOUND = 10_000
FLUSH_ATTEMPTS = 10
FLUSH_RETRY_SECONDS = 0.2

WARMUP_REQUESTS = 5
"""Fixed, not a parameter. So is the cache flush that follows the warmup.

Warmup exists to prime the runtime (CUDA graphs, memory pools), not to be
tuned; making it a knob would invite measurements that are not comparable
with each other. The value is shared by the executor, the duration estimate
and the CLI, so it lives here exactly once.
"""

ProgressCallback = Callable[[str, int, int], None]
"""``(phase, completed, total)`` — phase is "warmup", "flush" or "measured"."""

MAX_IN_FLIGHT = 256
"""Ceiling on simultaneous requests in open-loop mode.

Open loop paces *arrivals*, not *concurrency*. Without a ceiling a rate the
service cannot sustain would open a connection per queued request and measure
the client's own collapse rather than the service's behaviour. Hitting this
ceiling shows up as achieved QPS falling short of offered — which is the honest
signal, and there is deliberately no separate switch for it.
"""


@dataclass
class RequestObservation:
    """What one request told us. Failures are kept, not dropped."""

    success: bool
    e2e_ms: float
    ttft_ms: float | None = None
    tpot_ms: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cached_tokens: int | None = None
    finish_reason: str | None = None
    error: str | None = None


@dataclass
class LevelResult:
    """One level's measured outcome.

    ``concurrency`` is the level in closed-loop mode; ``request_rate`` is the
    level in open-loop mode. At most one of them is meaningful, and which one
    is recorded in the Run Signature.
    """

    concurrency: int
    total_requests: int
    successful_requests: int
    failed_requests: int
    duration_seconds: float
    request_rate: float | None = None
    observations: list[RequestObservation] = field(default_factory=list)

    @property
    def achieved_qps(self) -> float:
        if self.duration_seconds <= 0:
            return 0.0
        return self.successful_requests / self.duration_seconds

    @property
    def qps_attainment(self) -> float | None:
        """Achieved over offered. Only meaningful when a rate was offered."""
        if not self.request_rate:
            return None
        return self.achieved_qps / self.request_rate

    @property
    def output_token_throughput(self) -> float:
        if self.duration_seconds <= 0:
            return 0.0
        total = sum(
            o.completion_tokens or 0 for o in self.observations if o.success
        )
        return total / self.duration_seconds

    @property
    def input_token_throughput(self) -> float:
        if self.duration_seconds <= 0:
            return 0.0
        total = sum(o.prompt_tokens or 0 for o in self.observations if o.success)
        return total / self.duration_seconds

    @property
    def actual_concurrency(self) -> float | None:
        """Time-averaged requests in flight, from measured service intervals.

        Each observation's E2E interval begins after the sending-side semaphore
        is acquired. Summing their lengths and dividing by wall time gives the
        area under the in-flight count, including failed requests.
        """
        if self.duration_seconds <= 0 or not self.observations:
            return None
        return sum(o.e2e_ms for o in self.observations) / (1000 * self.duration_seconds)

    def _values(self, attribute: str) -> list[float]:
        values = (getattr(o, attribute) for o in self.observations if o.success)
        return [v for v in values if v is not None]

    def ttft_histogram(self) -> Histogram:
        return _histogram(self._values("ttft_ms"), TTFT_BUCKETS_MS)

    def tpot_histogram(self) -> Histogram:
        return _histogram(self._values("tpot_ms"), TPOT_BUCKETS_MS)

    def e2e_histogram(self) -> Histogram:
        return _histogram(self._values("e2e_ms"), E2E_BUCKETS_MS)

    def summaries(self) -> dict[str, dict[str, float | None]]:
        summaries = {
            name: {
                "mean": sum(values) / len(values) if values else None,
                "p50": percentile(values, 50),
                "p70": percentile(values, 70),
                "p95": percentile(values, 95),
                "p99": percentile(values, 99),
            }
            for name, values in (
                ("ttft_ms", self._values("ttft_ms")),
                ("tpot_ms", self._values("tpot_ms")),
                ("e2e_ms", self._values("e2e_ms")),
                ("input_tokens", self._values("prompt_tokens")),
                ("output_tokens", self._values("completion_tokens")),
            )
        }
        return summaries

    def finish_reasons(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for observation in self.observations:
            if observation.success and observation.finish_reason:
                counts[observation.finish_reason] = counts.get(observation.finish_reason, 0) + 1
        return counts

    def error_messages(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for observation in self.observations:
            if not observation.success and observation.error:
                counts[observation.error] = counts.get(observation.error, 0) + 1
        return counts


def _histogram(values: list[float], edges: tuple[float, ...]) -> Histogram:
    histogram = Histogram(edges)
    for value in values:
        histogram.add(value)
    return histogram


def build_prompt(input_tokens: int, rng: np.random.Generator) -> list[int]:
    """A synthetic prompt: raw token ids, no tokenizer involved.

    Every request gets freshly drawn ids rather than a shared prompt, so no
    request benefits from a prefix another request just populated.
    """
    if input_tokens < 1:
        raise ValueError(f"input_tokens must be >= 1, got {input_tokens}")
    return rng.integers(0, RANDOM_TOKEN_UPPER_BOUND, size=input_tokens).tolist()


STREAM_FIELDS = {
    "stream": True,
    "stream_options": {"include_usage": True, "continuous_usage_stats": True},
    "return_cached_tokens_details": True,
    "return_spec_tokens_details": True,
}
"""Forced onto every request. Streaming is not optional — TTFT is unobservable
without it — and the token accounting rides on the response."""


def build_payload(model: str, prompt: list[int], output_tokens: int) -> dict:
    """A synthetic request body: raw token ids, exact output length."""
    return {
        "model": model,
        "prompt": prompt,
        "max_tokens": output_tokens,
        "ignore_eos": True,
        **STREAM_FIELDS,
    }


def chat_payload(model: str, payload: dict) -> dict:
    """A business request body, made measurable without being rewritten.

    ``ignore_eos`` is added when the payload asks for a token limit: it makes
    the run repeatable, which is what a measurement needs, and without it a
    business workload's length varies with what the model decides to say. The
    payload itself is otherwise untouched — measuring a workload means sending
    the workload.
    """
    body = {**payload}
    body.setdefault("model", model)
    if body.get("max_tokens") or body.get("max_completion_tokens"):
        body.setdefault("ignore_eos", True)
    body.update(STREAM_FIELDS)
    return body


def auth_headers(api_key: str | None) -> dict[str, str]:
    """The credential is read from the environment by the caller; the key itself
    is never stored anywhere, so this is the only place it exists."""
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def flush_cache(
    session: aiohttp.ClientSession, base_url: str, headers: dict[str, str] | None = None
) -> bool:
    """Clear the KV cache. Never optional — see the design's comparability rules.

    Retries, because the server refuses to flush while requests are in flight.
    """
    for _ in range(FLUSH_ATTEMPTS):
        try:
            async with session.post(f"{base_url}{FLUSH_PATH}", headers=headers or {}) as response:
                if response.status == 200:
                    return True
        except aiohttp.ClientError:
            pass
        await asyncio.sleep(FLUSH_RETRY_SECONDS)
    return False


async def _one_request(
    session: aiohttp.ClientSession,
    url: str,
    payload: dict,
    semaphore: asyncio.Semaphore,
    headers: dict[str, str] | None = None,
) -> RequestObservation:
    async with semaphore:
        # Timing starts here, after the slot is held. Queue time is not
        # service time, and the design says so explicitly.
        started = time.perf_counter()
        reader = StreamReader(started_at=started)
        try:
            async with session.post(url, json=payload, headers=headers or {}) as response:
                if response.status != 200:
                    body = await response.text()
                    return RequestObservation(
                        success=False,
                        e2e_ms=_elapsed_ms(started),
                        error=f"http_{response.status}: {body[:200]}",
                    )
                async for chunk in response.content.iter_any():
                    reader.feed(chunk)
        except asyncio.TimeoutError:
            return RequestObservation(
                success=False, e2e_ms=_elapsed_ms(started), error="timeout"
            )
        except aiohttp.ClientError as exc:
            return RequestObservation(
                success=False,
                e2e_ms=_elapsed_ms(started),
                error=f"client_error: {type(exc).__name__}: {exc}",
            )

        e2e_ms = _elapsed_ms(started)
        observation = reader.finish()
        if observation.malformed_events:
            return RequestObservation(
                success=False,
                e2e_ms=e2e_ms,
                error=f"malformed_stream: {observation.malformed_events} event(s)",
            )
        if not observation.saw_done:
            return RequestObservation(
                success=False, e2e_ms=e2e_ms, error="stream_ended_without_done"
            )
        return RequestObservation(
            success=True,
            e2e_ms=e2e_ms,
            ttft_ms=observation.ttft_ms,
            tpot_ms=tpot_ms(
                e2e_ms=e2e_ms,
                ttft_ms=observation.ttft_ms,
                completion_tokens=observation.completion_tokens,
            ),
            prompt_tokens=observation.prompt_tokens,
            completion_tokens=observation.completion_tokens,
            cached_tokens=observation.cached_tokens,
            finish_reason=observation.finish_reason,
        )


def _elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000.0


async def run_level(
    *,
    base_url: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    concurrency: int,
    num_requests: int,
    request_rate: float | None = None,
    max_in_flight: int = MAX_IN_FLIGHT,
    seed: int = 42,
    timeout_seconds: float = 600.0,
    api_key: str | None = None,
    payloads: list[dict] | None = None,
    request_callback: Callable[[], None] | None = None,
) -> LevelResult:
    """Send ``num_requests`` and measure them.

    With ``payloads``, business requests are sent to the chat completions API
    instead of synthetic token ids to the completions API. The dataset is
    cycled when it is shorter than the request count — a workload of five
    distinct requests can still be measured a hundred times.

    Two modes, and they answer different questions:

    * closed loop (``request_rate=None``) holds ``concurrency`` requests in
      flight and asks "how much can this service handle at once".
    * open loop offers a fixed arrival rate and asks "how does it behave at the
      load I actually expect". This is the shape real traffic has — requests do
      not wait for the previous one to finish before arriving.
    """
    if num_requests < 1:
        raise ValueError(f"num_requests must be >= 1, got {num_requests}")
    if concurrency < 1:
        raise ValueError(f"concurrency must be >= 1, got {concurrency}")
    if request_rate is not None and request_rate <= 0:
        raise ValueError(f"request_rate must be > 0, got {request_rate}")

    headers = auth_headers(api_key)
    rng = np.random.default_rng(seed)
    if payloads is None:
        bodies = [
            build_payload(model, build_prompt(input_tokens, rng), output_tokens)
            for _ in range(num_requests)
        ]
        path = COMPLETIONS_PATH
    else:
        if not payloads:
            raise ValueError("a dataset workload needs at least one payload")
        bodies = [chat_payload(model, payloads[index % len(payloads)]) for index in range(num_requests)]
        path = CHAT_COMPLETIONS_PATH
    url = f"{base_url}{path}"

    if request_rate is None:
        in_flight = concurrency
        pacer = None
    else:
        in_flight = max_in_flight
        pacer = _Pacer(request_rate, rng)

    semaphore = asyncio.Semaphore(in_flight)
    connector = aiohttp.TCPConnector(limit=in_flight, limit_per_host=in_flight)
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        async def tracked(body: dict) -> RequestObservation:
            observation = await _one_request(session, url, body, semaphore, headers)
            if request_callback is not None:
                request_callback()
            return observation

        started = time.perf_counter()
        tasks = []
        for body in bodies:
            if pacer is not None:
                await pacer.wait()
            tasks.append(asyncio.create_task(tracked(body)))
        observations = list(await asyncio.gather(*tasks))
        duration_seconds = time.perf_counter() - started

    successful = sum(1 for o in observations if o.success)
    return LevelResult(
        concurrency=concurrency,
        total_requests=len(observations),
        successful_requests=successful,
        failed_requests=len(observations) - successful,
        duration_seconds=duration_seconds,
        request_rate=request_rate,
        observations=observations,
    )


class _Pacer:
    """Exponential gaps between arrivals.

    A constant gap is a metronome; real arrivals cluster and gap. Exponential
    is what a memoryless arrival process looks like, and it is what makes an
    overloaded service's failures cluster the way they will in production.
    """

    def __init__(self, rate: float, rng: np.random.Generator) -> None:
        self._mean_gap = 1.0 / rate
        self._rng = rng
        self._first = True

    async def wait(self) -> None:
        if self._first:
            self._first = False
            return  # the first request goes immediately
        await asyncio.sleep(float(self._rng.exponential(self._mean_gap)))


async def warmup(
    *,
    base_url: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    num_requests: int,
    concurrency: int = 1,
    seed: int = 0,
    timeout_seconds: float = 600.0,
    api_key: str | None = None,
    payloads: list[dict] | None = None,
    request_callback: Callable[[], None] | None = None,
) -> None:
    """Prime the runtime (CUDA graphs, memory pools) before measuring.

    Results are discarded. Done before the cache flush, so the flush still
    guarantees the measured requests face a cold prefix cache.
    """
    if num_requests <= 0:
        return
    headers = auth_headers(api_key)
    rng = np.random.default_rng(seed)
    if payloads is None:
        bodies = [
            build_payload(model, build_prompt(input_tokens, rng), output_tokens)
            for _ in range(num_requests)
        ]
        url = f"{base_url}{COMPLETIONS_PATH}"
    else:
        bodies = [chat_payload(model, payloads[index % len(payloads)]) for index in range(num_requests)]
        url = f"{base_url}{CHAT_COMPLETIONS_PATH}"
    semaphore = asyncio.Semaphore(concurrency)
    connector = aiohttp.TCPConnector(limit=concurrency, limit_per_host=concurrency)
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:

        async def tracked(body: dict) -> RequestObservation:
            observation = await _one_request(session, url, body, semaphore, headers)
            if request_callback is not None:
                request_callback()
            return observation

        await asyncio.gather(*(tracked(body) for body in bodies))


async def run_measured_level(
    *,
    base_url: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    concurrency: int,
    num_requests: int,
    warmup_requests: int = WARMUP_REQUESTS,
    request_rate: float | None = None,
    max_in_flight: int = MAX_IN_FLIGHT,
    seed: int = 42,
    timeout_seconds: float = 600.0,
    api_key: str | None = None,
    payloads: list[dict] | None = None,
    progress_callback: ProgressCallback | None = None,
) -> LevelResult:
    """One level, in the order the design fixes: warmup → flush → measure.

    Every level does this, not every process. Flushing after warmup is what
    makes the measured requests face a cold prefix cache; skipping it inflates
    throughput and reports nothing.

    ``progress_callback`` is invoked as requests complete, so a caller with
    somewhere to show it can answer "how far along is it" without guessing.
    """
    def report(phase: str, total: int) -> Callable[[], None] | None:
        if progress_callback is None:
            return None
        completed = 0

        def tick() -> None:
            nonlocal completed
            completed += 1
            progress_callback(phase, completed, total)

        progress_callback(phase, 0, total)
        return tick

    await warmup(
        base_url=base_url,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        num_requests=warmup_requests,
        concurrency=max(1, min(concurrency, warmup_requests)),
        seed=seed + 1,
        timeout_seconds=timeout_seconds,
        api_key=api_key,
        payloads=payloads,
        request_callback=report("warmup", warmup_requests),
    )
    if progress_callback is not None:
        progress_callback("flush", 0, 0)
    connector = aiohttp.TCPConnector(limit=1, limit_per_host=1)
    async with aiohttp.ClientSession(
        connector=connector, timeout=aiohttp.ClientTimeout(total=60.0)
    ) as session:
        if not await flush_cache(session, base_url, auth_headers(api_key)):
            raise RuntimeError(
                f"could not flush cache at {base_url}{FLUSH_PATH} — "
                "refusing to measure against a warm cache"
            )
    return await run_level(
        base_url=base_url,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        concurrency=concurrency,
        num_requests=num_requests,
        request_rate=request_rate,
        max_in_flight=max_in_flight,
        seed=seed,
        timeout_seconds=timeout_seconds,
        api_key=api_key,
        payloads=payloads,
        request_callback=report("measured", num_requests),
    )
