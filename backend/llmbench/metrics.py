"""Measurement maths: TPOT, percentiles, histograms.

Every function here is a *definition*, not an implementation detail. A silent
change to any of them moves every number the project reports, so they are
tested directly rather than only through end-to-end runs.
"""

from __future__ import annotations

import numpy as np

# Upper bounds of the finite buckets; values above the last edge fall into a
# final, open-ended bucket.
#
# Each metric gets its own edge set, because the three live an order of
# magnitude apart: TPOT is tens of milliseconds, TTFT hundreds, E2E seconds.
# One shared set would give usable resolution to exactly one of them.
#
# The constraint that matters is *within* a metric: every level of a given
# metric must use the same edges, or the per-level histograms cannot be added
# together into a whole-run distribution. Changing an edge set invalidates
# stored histograms for that metric.
TTFT_BUCKETS_MS: tuple[float, ...] = (
    10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 30000.0,
)
TPOT_BUCKETS_MS: tuple[float, ...] = (
    0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 250.0, 500.0,
)
E2E_BUCKETS_MS: tuple[float, ...] = (
    25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 30000.0, 60000.0, 120000.0,
)


def percentile(values: list[float], q: float) -> float | None:
    """Percentile with numpy's linear interpolation. ``q`` is in [0, 100].

    Returns None for an empty sample — never 0. A missing percentile and a
    zero percentile are different claims.
    """
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=float), q))


def tpot_ms(*, e2e_ms: float, ttft_ms: float | None, completion_tokens: int | None) -> float | None:
    """Time per output token, excluding the first token's latency.

    ``(e2e - ttft) / (completion_tokens - 1)``. The common wrong definition is
    ``e2e / completion_tokens``: it folds TTFT into every token and divides by
    one token too many.

    Returns None — not 0 — when the divisor would be non-positive or when TTFT
    was never observed. A token that never arrived has no per-token time.
    """
    if completion_tokens is None or completion_tokens <= 1:
        return None
    if ttft_ms is None or ttft_ms <= 0.0:
        return None
    generation_time_ms = e2e_ms - ttft_ms
    if generation_time_ms < 0.0:
        return None
    return generation_time_ms / (completion_tokens - 1)


class Histogram:
    """Fixed-bucket histogram over an explicit edge set.

    Buckets are additive, which is what lets a whole-run distribution be
    recovered by summing the per-level histograms instead of storing every
    sample. Edges are required rather than defaulted, so that no two metrics
    can silently end up sharing a set that suits neither.
    """

    __slots__ = ("edges", "_counts")

    def __init__(self, edges: tuple[float, ...]) -> None:
        self.edges = tuple(edges)
        self._counts = [0] * (len(self.edges) + 1)
        self._validate_edges()

    def _validate_edges(self) -> None:
        if list(self.edges) != sorted(self.edges) or len(set(self.edges)) != len(self.edges):
            raise ValueError(f"histogram edges must be strictly increasing, got {self.edges!r}")

    def add(self, value: float) -> None:
        self._counts[self._bucket_index(value)] += 1

    def _bucket_index(self, value: float) -> int:
        for i, edge in enumerate(self.edges):
            if value < edge:
                return i
        return len(self.edges)

    @property
    def counts(self) -> tuple[int, ...]:
        return tuple(self._counts)

    @property
    def total(self) -> int:
        return sum(self._counts)

    def merge(self, other: Histogram) -> None:
        """Add another histogram's counts into this one, in place."""
        if other.edges != self.edges:
            raise ValueError("cannot merge histograms with different bucket edges")
        for i, count in enumerate(other._counts):
            self._counts[i] += count

    def bucket_labels(self) -> list[str]:
        labels = [f"<{_fmt(self.edges[0])}"]
        for low, high in zip(self.edges, self.edges[1:]):
            labels.append(f"{_fmt(low)}-{_fmt(high)}")
        labels.append(f">={_fmt(self.edges[-1])}")
        return labels

    def as_dict(self) -> dict[str, int]:
        return dict(zip(self.bucket_labels(), self._counts))


def _fmt(value: float) -> str:
    return f"{value:g}"
