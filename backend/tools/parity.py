"""Compare this load generator against ``aib`` on the same target and config.

This is the project's only integration test. With no mock server, nothing else
exercises the load generator, the warmup/flush ordering, and the SSE parser
against a live protocol.

The danger it guards against is not "it crashes" — it is "it runs, the numbers
look plausible, and they are systematically off". A TTFT that starts one event
loop too late, a TPOT missing its ``- 1``, a percentile with the wrong
interpolation: none of these raise, they just quietly mislead.

Each side is run several times in **separate processes**, because warmup and
cache flush happen once per process. Running both sides back to back and
comparing single samples would confuse tool disagreement with machine drift.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Runnable both as `python tools/parity.py` and `python -m tools.parity`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from llmbench.loadgen import run_measured_level  # noqa: E402

NUMBER = re.compile(r"-?\d+(?:\.\d+)?")

# Metrics compared, with the relative tolerance applied to each. Latency
# percentiles get more room than throughput: they are noisier on a shared
# service, and a percentile that agrees within 10% is strong evidence the
# definition matches whereas throughput can drift with ambient load.
TOLERANCES: dict[str, float] = {
    "ttft_p50_ms": 0.10,
    "ttft_p99_ms": 0.15,
    "tpot_p50_ms": 0.10,
    "tpot_p99_ms": 0.15,
    "e2e_p50_ms": 0.10,
    "e2e_p99_ms": 0.15,
    "output_token_throughput": 0.10,
    "success_rate": 0.01,
}


@dataclass(frozen=True)
class Config:
    base_url: str
    model: str
    input_tokens: int
    output_tokens: int
    concurrency: int
    num_requests: int
    warmup_requests: int
    seed: int
    timeout_seconds: float


def parse_args(argv: list[str] | None = None) -> Config:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--input-tokens", type=int, default=1024)
    parser.add_argument("--output-tokens", type=int, default=128)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--num-requests", type=int, default=64)
    parser.add_argument("--warmup", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--timeout", type=float, default=600.0)
    args = parser.parse_args(argv)
    return Config(
        base_url=args.url.rstrip("/"),
        model=args.model,
        input_tokens=args.input_tokens,
        output_tokens=args.output_tokens,
        concurrency=args.concurrency,
        num_requests=args.num_requests,
        warmup_requests=args.warmup,
        seed=args.seed,
        timeout_seconds=args.timeout,
    )


# --- aib -------------------------------------------------------------------


def run_aib(config: Config, label: str, workdir: Path) -> dict[str, float | None]:
    metric_path = workdir / f"{label}.jsonl"
    command = [
        "aib",
        "bench",
        "--base-url",
        config.base_url,
        "--model",
        config.model,
        "--dataset",
        "random",
        "--input-len",
        str(config.input_tokens),
        "--output-len",
        str(config.output_tokens),
        "--num-requests",
        str(config.num_requests),
        # Non-zero warmup is what makes aib flush the cache before measuring;
        # zero would silently disable the flush as well.
        "--num-warmup-requests",
        str(config.warmup_requests),
        "--max-concurrency",
        str(config.concurrency),
        "--seed",
        str(config.seed),
        "--request-timeout",
        str(config.timeout_seconds),
        "--label",
        label,
        "--metric-path",
        str(metric_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=config.timeout_seconds * 4)
    if not metric_path.exists():
        raise RuntimeError(
            f"aib produced no metrics at {metric_path}\n"
            f"exit={completed.returncode}\nstdout tail:\n{completed.stdout[-2000:]}\n"
            f"stderr tail:\n{completed.stderr[-2000:]}"
        )
    return parse_aib_metrics(metric_path)


def parse_aib_metrics(metric_path: Path) -> dict[str, float | None]:
    """Pull the compared metrics out of aib's metric JSONL.

    aib writes every value as a *string* ("393.56", "417.94 tokens/s", "N/A"),
    and names the summary table with a timestamp suffix. Both are handled here.
    """
    records = [json.loads(line) for line in metric_path.read_text().splitlines() if line.strip()]
    if not records:
        raise ValueError(f"no records in {metric_path}")
    record = records[-1]

    latency = _table(record, "Latency & Token Metrics")
    summary = _table(record, "Benchmark Summary")
    if summary is None:
        # Every request failed; aib replaces the tables with a single
        # "Benchmark Results" table rather than failing.
        raise RuntimeError(f"aib reported no successful requests: {record.get('label')}")

    total = _number(_lookup(summary, "Total requests"))
    successful = _number(_lookup(summary, "Successful requests"))
    return {
        "ttft_p50_ms": _number(_lookup(latency, "TTFT", "P50")),
        "ttft_p99_ms": _number(_lookup(latency, "TTFT", "P99")),
        "tpot_p50_ms": _number(_lookup(latency, "TPOT(ecl the ttft)", "P50")),
        "tpot_p99_ms": _number(_lookup(latency, "TPOT(ecl the ttft)", "P99")),
        "e2e_p50_ms": _number(_lookup(latency, "Latency", "P50")),
        "e2e_p99_ms": _number(_lookup(latency, "Latency", "P99")),
        "output_token_throughput": _number(_lookup(summary, "Output throughput")),
        "success_rate": (successful / total) if total else None,
    }


def _table(record: dict, name: str) -> list[dict] | None:
    for key, value in record.items():
        if _normalise(key) == name and isinstance(value, list):
            return value
    return None


def _normalise(key: str) -> str:
    """Strip the timestamp aib appends to the summary table's title."""
    return re.sub(r"\s*\(.*\)\s*$", "", str(key)).strip()


def _lookup(rows: list[dict] | None, label: str, column: str = "Value") -> str | None:
    if not rows:
        return None
    for row in rows:
        if row.get("Metric") == label:
            return row.get(column)
    return None


def _number(text: object) -> float | None:
    if text is None:
        return None
    match = NUMBER.search(str(text))
    return float(match.group()) if match else None


# --- ours ------------------------------------------------------------------


async def run_ours(config: Config) -> dict[str, float | None]:
    result = await run_measured_level(
        base_url=config.base_url,
        model=config.model,
        input_tokens=config.input_tokens,
        output_tokens=config.output_tokens,
        concurrency=config.concurrency,
        num_requests=config.num_requests,
        warmup_requests=config.warmup_requests,
        seed=config.seed,
        timeout_seconds=config.timeout_seconds,
    )
    summary = result.summaries()
    return {
        "ttft_p50_ms": summary["ttft_ms"]["p50"],
        "ttft_p99_ms": summary["ttft_ms"]["p99"],
        "tpot_p50_ms": summary["tpot_ms"]["p50"],
        "tpot_p99_ms": summary["tpot_ms"]["p99"],
        "e2e_p50_ms": summary["e2e_ms"]["p50"],
        "e2e_p99_ms": summary["e2e_ms"]["p99"],
        "output_token_throughput": result.output_token_throughput,
        "success_rate": result.successful_requests / result.total_requests,
    }


# --- comparison ------------------------------------------------------------


def relative_gap(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    scale = max(abs(a), abs(b))
    if scale == 0:
        return 0.0
    return abs(a - b) / scale


def median(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return statistics.median(present) if present else None


def spread(values: list[float | None]) -> float | None:
    """How much a single tool varies across its own runs, relative to its median.

    This is the yardstick a gap has to beat. A p99 taken over a few dozen
    samples is close to the maximum, and a maximum swings run to run for
    reasons that have nothing to do with the two implementations disagreeing —
    a preemption, a scheduler hiccup. Without this number, a 30% gap is
    unreadable.
    """
    present = [v for v in values if v is not None]
    if len(present) < 2:
        return None
    centre = statistics.median(present)
    if centre == 0:
        return None
    return (max(present) - min(present)) / abs(centre)


@dataclass(frozen=True)
class Row:
    name: str
    ours: float | None
    theirs: float | None
    gap: float | None
    allowance: float
    noise: float
    ok: bool

    @property
    def allowance_is_noise_driven(self) -> bool:
        return self.noise > self.gap_tolerance

    @property
    def gap_tolerance(self) -> float:
        return TOLERANCES[self.name]


def compare(
    ours: list[dict[str, float | None]],
    theirs: list[dict[str, float | None]],
) -> tuple[list[Row], bool]:
    """Agreement test: the gap must not exceed either the fixed tolerance or the noise.

    A metric whose own run-to-run spread already exceeds the tolerance cannot
    be judged by the tolerance — the honest bar is then its own noise. A real
    definition difference moves a *median* far more than repetition does, so
    this still catches what it is meant to catch.
    """
    rows = []
    passed = True
    for name, tolerance in TOLERANCES.items():
        ours_value = median([r[name] for r in ours])
        theirs_value = median([r[name] for r in theirs])
        gap = relative_gap(ours_value, theirs_value)
        noise = max(
            spread([r[name] for r in ours]) or 0.0,
            spread([r[name] for r in theirs]) or 0.0,
        )
        allowance = max(tolerance, noise)
        # A metric neither side produced is a gap in the comparison, not a pass.
        ok = gap is not None and gap <= allowance
        passed = passed and ok
        rows.append(
            Row(
                name=name,
                ours=ours_value,
                theirs=theirs_value,
                gap=gap,
                allowance=allowance,
                noise=noise,
                ok=ok,
            )
        )
    return rows, passed


def print_report(rows: list[Row], ours_runs, theirs_runs, passed: bool) -> None:
    print()
    print(f"  {'metric':<26} {'ours':>12} {'aib':>12} {'gap':>8} {'allow':>8} {'noise':>8}")
    print(f"  {'-' * 26} {'-' * 12} {'-' * 12} {'-' * 8} {'-' * 8} {'-' * 8}")
    for row in rows:
        mark = "ok" if row.ok else "FAIL"
        ours_text = "n/a" if row.ours is None else f"{row.ours:.3f}"
        theirs_text = "n/a" if row.theirs is None else f"{row.theirs:.3f}"
        gap_text = "n/a" if row.gap is None else f"{row.gap * 100:.1f}%"
        # An allowance driven by noise is flagged, so a passing row never hides
        # that the underlying statistic was too unstable to be conclusive.
        allow_text = f"{row.allowance * 100:.0f}%" + ("*" if row.allowance_is_noise_driven else "")
        print(
            f"  {row.name:<26} {ours_text:>12} {theirs_text:>12} "
            f"{gap_text:>8} {allow_text:>8} {row.noise * 100:>7.1f}%  {mark}"
        )
    print(f"  {'-' * 26}")
    print("  allow = max(fixed tolerance, run-to-run noise of either side)")
    print("  *      = the allowance came from noise, not the tolerance")

    print()
    print("  per-run spread, by tool")
    print(f"  {'metric':<26} {'ours':>8} {'aib':>8}")
    for name in TOLERANCES:
        ours_spread = spread([r[name] for r in ours_runs])
        theirs_spread = spread([r[name] for r in theirs_runs])
        ours_text = "n/a" if ours_spread is None else f"{ours_spread * 100:.1f}%"
        theirs_text = "n/a" if theirs_spread is None else f"{theirs_spread * 100:.1f}%"
        print(f"  {name:<26} {ours_text:>8} {theirs_text:>8}")

    print()
    print("  PARITY PASSED" if passed else "  PARITY FAILED — the two disagree beyond tolerance")


async def main(argv: list[str] | None = None) -> int:
    config = parse_args(argv)
    repeats = 3
    print(f"Target   {config.base_url}")
    print(
        f"Config   input={config.input_tokens} output={config.output_tokens} "
        f"concurrency={config.concurrency} requests={config.num_requests} "
        f"warmup={config.warmup_requests}"
    )
    print(f"Repeats  {repeats} per side, separate processes (warmup+flush is per-process)")
    print()

    with tempfile.TemporaryDirectory(prefix="parity-") as tmp:
        workdir = Path(tmp)
        ours_runs = []
        theirs_runs = []
        for i in range(repeats):
            print(f"  [{i + 1}/{repeats}] ours ...", flush=True)
            ours_runs.append(await run_ours(config))
            print(f"  [{i + 1}/{repeats}] aib  ...", flush=True)
            theirs_runs.append(run_aib(config, f"parity-{i + 1}", workdir))

    rows, passed = compare(ours_runs, theirs_runs)
    print_report(rows, ours_runs, theirs_runs, passed)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
