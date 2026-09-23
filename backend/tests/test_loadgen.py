"""Load generator: the parts that need no network.

How the concurrency cap and the timing-window behaviour are verified is
described in ticket 01 — they are checked against a live target by arithmetic
(duration ≈ ceil(requests/concurrency) × E2E), not by a fake server.
"""

from __future__ import annotations

import numpy as np
import pytest

import asyncio

from llmbench.loadgen import (
    LevelResult,
    RequestObservation,
    _Pacer,
    build_payload,
    build_prompt,
)


class TestBuildPrompt:
    def test_length_matches_the_request(self):
        rng = np.random.default_rng(1)
        assert len(build_prompt(64, rng)) == 64

    def test_token_ids_stay_within_the_modelled_vocabulary(self):
        rng = np.random.default_rng(1)
        tokens = build_prompt(512, rng)
        assert min(tokens) >= 0
        assert max(tokens) < 10_000

    def test_each_call_draws_fresh_tokens(self):
        """Requests must not share a prefix, or one warms the cache for the next."""
        rng = np.random.default_rng(1)
        assert build_prompt(64, rng) != build_prompt(64, rng)

    def test_zero_tokens_is_rejected(self):
        with pytest.raises(ValueError):
            build_prompt(0, np.random.default_rng(1))


class TestBuildPayload:
    def test_streaming_is_forced(self):
        """TTFT is unobservable without it, so it is not the caller's choice."""
        payload = build_payload("m", [1, 2, 3], 8)
        assert payload["stream"] is True
        assert payload["stream_options"]["include_usage"] is True

    def test_eos_is_ignored_so_output_length_is_controlled(self):
        payload = build_payload("m", [1, 2, 3], 8)
        assert payload["ignore_eos"] is True
        assert payload["max_tokens"] == 8

    def test_model_and_prompt_are_carried_through(self):
        payload = build_payload("DeepSeek-V4-Flash-0731", [1, 2, 3], 8)
        assert payload["model"] == "DeepSeek-V4-Flash-0731"
        assert payload["prompt"] == [1, 2, 3]


def observation(**kwargs) -> RequestObservation:
    defaults = {"success": True, "e2e_ms": 100.0}
    return RequestObservation(**{**defaults, **kwargs})


class TestPacer:
    """Open loop offers a rate; the gaps between arrivals are what make it real."""

    def test_the_first_request_is_immediate(self, monkeypatch):
        slept: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            slept.append(seconds)

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        asyncio.run(_Pacer(10.0, np.random.default_rng(1)).wait())
        assert slept == []

    def test_later_requests_wait_a_positive_gap(self, monkeypatch):
        slept: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            slept.append(seconds)

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        pacer = _Pacer(10.0, np.random.default_rng(1))
        asyncio.run(self.drain(pacer, 5))
        assert len(slept) == 4
        assert all(gap > 0 for gap in slept)

    def test_the_mean_gap_is_one_over_the_rate(self, monkeypatch):
        """Exponential, not constant: real arrivals cluster and gap."""
        slept: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            slept.append(seconds)

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        asyncio.run(self.drain(_Pacer(20.0, np.random.default_rng(7)), 400))
        assert sum(slept) / len(slept) == pytest.approx(1 / 20.0, rel=0.25)

    def test_the_gaps_are_not_all_identical(self, monkeypatch):
        slept: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            slept.append(seconds)

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        asyncio.run(self.drain(_Pacer(5.0, np.random.default_rng(3)), 20))
        assert len(set(slept)) > 10

    @staticmethod
    async def drain(pacer: _Pacer, count: int) -> None:
        for _ in range(count):
            await pacer.wait()


class TestLevelResult:
    def result_with(self, *observations: RequestObservation) -> LevelResult:
        successful = sum(1 for o in observations if o.success)
        return LevelResult(
            concurrency=4,
            total_requests=len(observations),
            successful_requests=successful,
            failed_requests=len(observations) - successful,
            duration_seconds=2.0,
            observations=list(observations),
        )

    def test_achieved_qps_uses_successes_only(self):
        result = self.result_with(observation(), observation(), observation(success=False, error="x"))
        assert result.achieved_qps == pytest.approx(1.0)

    def test_output_token_throughput_uses_successes_only(self):
        result = self.result_with(
            observation(completion_tokens=100),
            observation(completion_tokens=100),
            observation(success=False, completion_tokens=100, error="x"),
        )
        assert result.output_token_throughput == pytest.approx(100.0)

    def test_a_failed_request_is_counted_but_kept_out_of_the_metrics(self):
        result = self.result_with(observation(e2e_ms=1000.0), observation(success=False, error="boom"))
        assert result.failed_requests == 1
        assert result.summaries()["e2e_ms"]["p50"] == pytest.approx(1000.0)

    def test_percentiles_are_none_when_nothing_succeeded(self):
        result = self.result_with(observation(success=False, error="boom"))
        assert result.summaries()["ttft_ms"]["p50"] is None

    def test_a_missing_tpot_is_excluded_rather_than_treated_as_zero(self):
        """A single-token response has no per-token time; it must not drag the p50 down."""
        result = self.result_with(observation(tpot_ms=None), observation(tpot_ms=20.0))
        assert result.summaries()["tpot_ms"]["p50"] == pytest.approx(20.0)

    def test_finish_reasons_count_successes_only(self):
        result = self.result_with(
            observation(finish_reason="length"),
            observation(finish_reason="length"),
            observation(finish_reason="stop"),
            observation(success=False, finish_reason="length", error="x"),
        )
        assert result.finish_reasons() == {"length": 2, "stop": 1}

    def test_error_messages_are_aggregated(self):
        result = self.result_with(
            observation(success=False, error="timeout"),
            observation(success=False, error="timeout"),
            observation(success=False, error="http_500"),
        )
        assert result.error_messages() == {"timeout": 2, "http_500": 1}

    def test_qps_attainment_is_only_meaningful_when_a_rate_was_offered(self):
        closed_loop = self.result_with(observation())
        assert closed_loop.request_rate is None
        assert closed_loop.qps_attainment is None

    def test_qps_attainment_compares_achieved_to_offered(self):
        result = LevelResult(
            concurrency=64,
            total_requests=100,
            successful_requests=80,
            failed_requests=20,
            duration_seconds=10.0,
            request_rate=10.0,
        )
        # 80 successes in 10s is 8 req/s against an offered 10.
        assert result.achieved_qps == pytest.approx(8.0)
        assert result.qps_attainment == pytest.approx(0.8)
