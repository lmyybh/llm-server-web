"""Wall-clock estimates for Cells."""

from __future__ import annotations

import pytest

from llmbench.loadgen import WARMUP_REQUESTS
from server.estimate import (
    DEFAULT_LATENCY_SECONDS,
    FLUSH_OVERHEAD_SECONDS,
    cell_seconds,
    cells_seconds,
)


class TestCellSeconds:
    def test_closed_loop_counts_waves(self):
        # 100 requests at 10 in flight is 10 waves of 1 second each.
        seconds = cell_seconds(mode="concurrency", level=10, num_requests=100, latency_seconds=1.0)
        assert seconds == pytest.approx(10.0 + 1.0 + FLUSH_OVERHEAD_SECONDS)

    def test_a_partial_final_wave_still_costs_a_full_wave(self):
        seconds = cell_seconds(mode="concurrency", level=10, num_requests=101, latency_seconds=1.0)
        assert seconds == pytest.approx(11.0 + 1.0 + FLUSH_OVERHEAD_SECONDS)

    def test_open_loop_lasts_as_long_as_offering_takes(self):
        # 100 requests at 10/s takes 10 seconds, whatever the latency.
        seconds = cell_seconds(mode="qps", level=10.0, num_requests=100, latency_seconds=1.0)
        assert seconds == pytest.approx(10.0 + 1.0 + FLUSH_OVERHEAD_SECONDS)

    def test_open_loop_at_a_slow_rate_is_not_shortened_by_fast_responses(self):
        seconds = cell_seconds(mode="qps", level=1.0, num_requests=60, latency_seconds=0.1)
        assert seconds >= 60.0

    def test_open_loop_is_lengthened_when_the_in_flight_ceiling_binds(self):
        """A rate the service cannot absorb takes longer than the pace implies."""
        paced = 1000 / 100.0  # 10 seconds by pace
        seconds = cell_seconds(mode="qps", level=100.0, num_requests=1000, latency_seconds=30.0)
        assert seconds > paced

    def test_warmup_is_fixed_at_five(self):
        assert WARMUP_REQUESTS == 5


class TestCellsSeconds:
    def test_every_cell_is_counted(self):
        _, count, _ = cells_seconds(mode="concurrency", levels=[1, 8], num_requests=10)
        assert count == 2

    def test_the_total_is_the_sum_of_the_cells(self):
        total, _, _ = cells_seconds(
            mode="concurrency", levels=[1, 8], num_requests=10, latency_seconds=1.0
        )
        expected = sum(
            cell_seconds(mode="concurrency", level=level, num_requests=10, latency_seconds=1.0)
            for level in [1, 8]
        )
        assert total == pytest.approx(expected)

    def test_an_unknown_latency_is_flagged_rather_than_hidden(self):
        _, _, guessed = cells_seconds(mode="concurrency", levels=[1], num_requests=10)
        assert guessed is True

    def test_a_known_latency_is_not_flagged(self):
        _, _, guessed = cells_seconds(
            mode="concurrency", levels=[1], num_requests=10, latency_seconds=0.5
        )
        assert guessed is False

    def test_the_fixed_cost_is_paid_again_for_every_cell(self):
        """A ladder of twenty Cells pays warmup and flush twenty times."""
        one = cells_seconds(
            mode="concurrency", levels=[8], num_requests=8, latency_seconds=1.0
        )[0]
        two = cells_seconds(
            mode="concurrency", levels=[8, 16], num_requests=8, latency_seconds=1.0
        )[0]
        # Both cells finish in one wave, so the difference is one cell's fixed
        # cost plus its wave.
        assert two - one == pytest.approx(1.0 + 1.0 + FLUSH_OVERHEAD_SECONDS)

    def test_the_default_is_a_guess_not_a_measurement(self):
        guessed, _, _ = cells_seconds(mode="concurrency", levels=[8], num_requests=10)
        measured, _, _ = cells_seconds(
            mode="concurrency", levels=[8], num_requests=10, latency_seconds=1.0
        )
        assert DEFAULT_LATENCY_SECONDS > 1.0
        assert guessed > measured
