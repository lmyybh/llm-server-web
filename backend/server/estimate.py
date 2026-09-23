"""How long Cells will take, before committing to them.

A global serial queue makes this matter: while one Cell is going, nothing
else starts. "I have to wait" is survivable; "I have to wait and have no idea
how long" is what makes a tool feel broken.

The estimate is deliberately crude and says so — its job is to be the right
order of magnitude, not to be a promise.
"""

from __future__ import annotations

import math

from llmbench.loadgen import MAX_IN_FLIGHT

DEFAULT_LATENCY_SECONDS = 2.0
"""Used until this deployment has measured anything. A guess, and labelled as
one wherever it is shown."""

FLUSH_OVERHEAD_SECONDS = 2.0
"""Cache flush plus connection setup, per Cell. Small but not nothing: a
ladder of twenty Cells pays it twenty times."""


def cell_seconds(
    *,
    mode: str,
    level: float,
    num_requests: int,
    latency_seconds: float,
) -> float:
    """One Cell's wall clock: warmup + flush + the measured requests.

    Warmup costs about one latency regardless of how many requests it holds:
    it runs without the concurrency limit, so its requests overlap.
    """
    warmup_seconds = latency_seconds

    if mode == "qps":
        # The measurement lasts as long as it takes to offer every request at
        # this rate — unless the in-flight ceiling makes it take longer.
        paced = num_requests / level
        bounded = math.ceil(num_requests / MAX_IN_FLIGHT) * latency_seconds
        return max(paced, bounded) + warmup_seconds + FLUSH_OVERHEAD_SECONDS

    waves = math.ceil(num_requests / level)
    return waves * latency_seconds + warmup_seconds + FLUSH_OVERHEAD_SECONDS


def cells_seconds(
    *,
    mode: str,
    levels: list[float],
    num_requests: int,
    latency_seconds: float | None = None,
) -> tuple[float, int, bool]:
    """A ladder's estimate: ``(seconds, cell count, whether latency was guessed)``."""
    guessed = latency_seconds is None
    latency = latency_seconds or DEFAULT_LATENCY_SECONDS
    total = sum(
        cell_seconds(mode=mode, level=level, num_requests=num_requests, latency_seconds=latency)
        for level in levels
    )
    return total, len(levels), guessed
