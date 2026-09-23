"""The measurement maths, tested as definitions."""

from __future__ import annotations

import pytest

from llmbench.metrics import (
    E2E_BUCKETS_MS,
    TPOT_BUCKETS_MS,
    TTFT_BUCKETS_MS,
    Histogram,
    percentile,
    tpot_ms,
)


class TestBucketEdges:
    """Each metric gets its own resolution; all are valid edge sets."""

    @pytest.mark.parametrize(
        "edges", [TTFT_BUCKETS_MS, TPOT_BUCKETS_MS, E2E_BUCKETS_MS], ids=["ttft", "tpot", "e2e"]
    )
    def test_edges_are_strictly_increasing(self, edges):
        assert list(edges) == sorted(edges)
        assert len(set(edges)) == len(edges)

    def test_the_three_metrics_do_not_share_one_edge_set(self):
        """TPOT is tens of ms, TTFT hundreds, E2E seconds."""
        assert TTFT_BUCKETS_MS != TPOT_BUCKETS_MS
        assert TTFT_BUCKETS_MS != E2E_BUCKETS_MS
        assert TPOT_BUCKETS_MS != E2E_BUCKETS_MS


class TestTpot:
    def test_excludes_ttft_and_the_first_token(self):
        # 3 tokens: TTFT covers the first, so 2 gaps remain.
        assert tpot_ms(e2e_ms=1000.0, ttft_ms=200.0, completion_tokens=3) == pytest.approx(400.0)

    def test_a_single_token_has_no_per_token_time(self):
        assert tpot_ms(e2e_ms=1000.0, ttft_ms=200.0, completion_tokens=1) is None

    def test_zero_tokens_has_no_per_token_time(self):
        assert tpot_ms(e2e_ms=1000.0, ttft_ms=200.0, completion_tokens=0) is None

    def test_missing_completion_tokens_is_not_zero(self):
        assert tpot_ms(e2e_ms=1000.0, ttft_ms=200.0, completion_tokens=None) is None

    def test_no_ttft_means_no_tpot(self):
        """A token that never arrived has no per-token time — not zero."""
        assert tpot_ms(e2e_ms=1000.0, ttft_ms=None, completion_tokens=8) is None

    def test_e2e_before_ttft_is_rejected_rather_than_negative(self):
        assert tpot_ms(e2e_ms=100.0, ttft_ms=200.0, completion_tokens=8) is None

    def test_never_divides_by_the_full_token_count(self):
        """The common wrong definition is e2e / completion_tokens."""
        right = tpot_ms(e2e_ms=1000.0, ttft_ms=200.0, completion_tokens=3)
        wrong = 1000.0 / 3
        assert right != pytest.approx(wrong)


class TestPercentile:
    def test_uses_numpy_linear_interpolation(self):
        assert percentile([1.0, 2.0, 3.0, 4.0], 50) == pytest.approx(2.5)
        assert percentile([1.0, 2.0, 3.0, 4.0], 95) == pytest.approx(3.85)

    def test_empty_sample_returns_none_not_zero(self):
        assert percentile([], 99) is None

    def test_single_sample(self):
        assert percentile([7.0], 99) == pytest.approx(7.0)


class TestHistogram:
    def test_values_fall_into_the_bucket_below_their_edge(self):
        histogram = Histogram((10.0, 20.0))  # two edges, three buckets
        histogram.add(5.0)
        histogram.add(10.0)  # equal to an edge belongs to the *next* bucket
        histogram.add(25.0)
        assert histogram.counts == (1, 1, 1)

    def test_total_counts_every_sample(self):
        histogram = Histogram((10.0, 20.0))
        for value in (1.0, 15.0, 19.9, 100.0):
            histogram.add(value)
        assert histogram.total == 4

    def test_merge_is_additive(self):
        left = Histogram((10.0, 20.0))
        left.add(5.0)
        right = Histogram((10.0, 20.0))
        right.add(15.0)
        right.add(5.0)
        left.merge(right)
        assert left.counts == (2, 1, 0)
        assert left.total == 3

    def test_merging_histograms_with_different_edges_is_refused(self):
        left = Histogram((10.0, 20.0))
        right = Histogram((10.0, 30.0))
        with pytest.raises(ValueError):
            left.merge(right)

    def test_edges_must_be_strictly_increasing(self):
        with pytest.raises(ValueError):
            Histogram((10.0, 10.0))

    def test_labels_cover_every_bucket(self):
        histogram = Histogram((10.0, 20.0))
        labels = histogram.bucket_labels()
        assert len(labels) == 3
        assert len(histogram.as_dict()) == 3
