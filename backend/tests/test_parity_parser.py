"""The aib output parser and the comparison maths.

The parser is the fragile edge of the parity check: aib writes every value as
a *string* and suffixes the summary table's name with a timestamp, so a change
on its side would silently produce Nones and a "passing" comparison where
nothing was actually compared.
"""

from __future__ import annotations

import json

import pytest

from tools.parity import (
    compare,
    median,
    parse_aib_metrics,
    relative_gap,
)

RECORD = {
    "label": "parity-1",
    "timestamp": "2026-09-17 11:17:15",
    "max_concurrency": 8,
    "Benchmark Summary (parity-1 2026-09-17 11:17:15)": [
        {"Metric": "Total requests", "Value": "64"},
        {"Metric": "Successful requests", "Value": "64"},
        {"Metric": "Failed requests", "Value": "0"},
        {"Metric": "Request Throughput", "Value": "3.27 req/s"},
        {"Metric": "Output throughput", "Value": "417.94 tokens/s"},
    ],
    "Latency & Token Metrics": [
        {"Metric": "TTFT", "Mean": "788.69", "P50": "788.69", "P95": "801.24", "P99": "805.87", "Unit": "ms"},
        {"Metric": "TPOT(ecl the ttft)", "Mean": "13.07", "P50": "13.07", "P95": "13.38", "P99": "13.40", "Unit": "ms"},
        {"Metric": "Latency", "Mean": "2446.79", "P50": "2446.79", "P95": "2487.26", "P99": "2487.94", "Unit": "ms"},
    ],
    "Finish Reason Statistics": [
        {"Finish reason": "length", "Requests": "64", "Percentage": "100.00%"},
    ],
}


def write(tmp_path, record):
    path = tmp_path / "aib.jsonl"
    path.write_text(json.dumps(record) + "\n")
    return path


def test_parses_the_metrics_we_compare(tmp_path):
    metrics = parse_aib_metrics(write(tmp_path, RECORD))
    assert metrics["ttft_p50_ms"] == pytest.approx(788.69)
    assert metrics["ttft_p99_ms"] == pytest.approx(805.87)
    assert metrics["tpot_p50_ms"] == pytest.approx(13.07)
    assert metrics["e2e_p50_ms"] == pytest.approx(2446.79)
    assert metrics["output_token_throughput"] == pytest.approx(417.94)
    assert metrics["success_rate"] == pytest.approx(1.0)


def test_the_timestamped_summary_title_is_matched(tmp_path):
    """aib names the summary table "Benchmark Summary (<label> <timestamp>)"."""
    record = dict(RECORD)
    record["Benchmark Summary (some label 2030-01-01 00:00:00)"] = record.pop(
        "Benchmark Summary (parity-1 2026-09-17 11:17:15)"
    )
    metrics = parse_aib_metrics(write(tmp_path, record))
    assert metrics["output_token_throughput"] == pytest.approx(417.94)


def test_na_is_unknown_not_zero(tmp_path):
    record = json.loads(json.dumps(RECORD))
    record["Latency & Token Metrics"][0]["P99"] = "N/A"
    metrics = parse_aib_metrics(write(tmp_path, record))
    assert metrics["ttft_p99_ms"] is None


def test_a_run_with_no_successes_is_an_error_not_a_silent_zero(tmp_path):
    """aib exits 0 even when every request failed; its tables vanish."""
    record = {
        "label": "parity-1",
        "timestamp": "2026-09-17 11:17:15",
        "max_concurrency": 8,
        "Benchmark Results": [
            {"Metric": "Total requests", "Value": "64"},
            {"Metric": "Successful requests", "Value": "0"},
            {"Metric": "Status", "Value": "No successful requests"},
        ],
    }
    with pytest.raises(RuntimeError, match="no successful requests"):
        parse_aib_metrics(write(tmp_path, record))


def test_uses_the_last_record_when_the_file_was_appended_to(tmp_path):
    path = tmp_path / "aib.jsonl"
    first = json.loads(json.dumps(RECORD))
    first["Latency & Token Metrics"][0]["P50"] = "1.0"
    second = json.loads(json.dumps(RECORD))
    second["Latency & Token Metrics"][0]["P50"] = "788.69"
    path.write_text(json.dumps(first) + "\n" + json.dumps(second) + "\n")
    assert parse_aib_metrics(path)["ttft_p50_ms"] == pytest.approx(788.69)


class TestRelativeGap:
    def test_identical_values_have_no_gap(self):
        assert relative_gap(100.0, 100.0) == 0.0

    def test_gap_is_scaled_by_the_larger_value(self):
        """Scaling by the larger value keeps the measure symmetric."""
        assert relative_gap(90.0, 110.0) == pytest.approx(20.0 / 110.0)
        assert relative_gap(110.0, 90.0) == pytest.approx(20.0 / 110.0)

    def test_a_missing_side_has_no_gap_to_report(self):
        assert relative_gap(None, 100.0) is None


class TestMedian:
    def test_ignores_missing_values(self):
        assert median([10.0, None, 20.0]) == pytest.approx(15.0)

    def test_all_missing_is_none(self):
        assert median([None, None]) is None


class TestCompare:
    def metrics(self, ttft: float, throughput: float = 400.0) -> dict:
        return {
            "ttft_p50_ms": ttft,
            "ttft_p99_ms": ttft * 1.02,
            "tpot_p50_ms": 13.0,
            "tpot_p99_ms": 13.3,
            "e2e_p50_ms": 2400.0,
            "e2e_p99_ms": 2450.0,
            "output_token_throughput": throughput,
            "success_rate": 1.0,
        }

    def test_close_agreement_passes(self):
        _, passed = compare([self.metrics(790.0)], [self.metrics(800.0)])
        assert passed

    def test_a_large_disagreement_fails(self):
        _, passed = compare([self.metrics(400.0)], [self.metrics(800.0)])
        assert not passed

    def test_a_metric_neither_side_produced_fails_rather_than_passes(self):
        """A comparison that silently skipped a metric would be worse than none."""
        ours = self.metrics(790.0)
        theirs = self.metrics(790.0)
        ours["ttft_p50_ms"] = None
        theirs["ttft_p50_ms"] = None
        _, passed = compare([ours], [theirs])
        assert not passed
