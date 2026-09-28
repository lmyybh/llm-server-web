"""The executor subprocess: one process per Cell, spawned by the backend.

It owns everything produced **during** a measurement — the result columns,
the executed snapshot and the progress column on the cell row. It never
touches status, error or timings, because those belong to the backend: only
the backend can observe whether this process is still alive.

Run with ``python -m server.runner --cell-id N`` from the backend directory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys
import time
import traceback
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from llmbench import __version__ as llmbench_version
from llmbench import datasets
from llmbench.loadgen import (
    MAX_IN_FLIGHT,
    WARMUP_REQUESTS,
    LevelResult,
    run_measured_level,
)

from . import store
from .config import ARTIFACTS_ROOT, database_path

SEED = 42
"""Fixed, not a parameter — like the warmup count and the flush after it."""

_PHASE_LABELS = {"warmup": "预热", "flush": "清缓存", "measured": "测量"}

PROGRESS_WRITE_INTERVAL_SECONDS = 1.0
"""The database is the only channel to the page; writing per request would
make the progress column the bottleneck of the measurement it describes."""


def _snapshot(cell: dict, deployment: dict, workload: dict) -> dict:
    """The configuration frozen at execution time.

    This is what the page's "结果来自旧配置" warning compares against, and
    what a future second executor would need to be interpretable.
    """
    return {
        "workload": {
            "id": workload["id"],
            "name": workload["name"],
            "kind": workload["kind"],
            "input_tokens": workload["input_tokens"],
            "output_tokens": workload["output_tokens"],
            "dataset": workload["dataset"],
        },
        "mode": cell["mode"],
        "level": cell["level"],
        "num_requests": cell["num_requests"],
        "warmup_requests": WARMUP_REQUESTS,
        "flush_cache": True,
        "seed": SEED,
        "executor": socket.gethostname(),
        "tool": f"llmbench {llmbench_version}",
    }


def _cell_result(result: LevelResult, snapshot: dict) -> dict:
    """Flatten a LevelResult into the columns ``cell`` has."""
    summaries = result.summaries()
    return {
        "executed_snapshot_json": snapshot,
        "total_requests": result.total_requests,
        "successful_requests": result.successful_requests,
        "failed_requests": result.failed_requests,
        "duration_seconds": result.duration_seconds,
        "offered_qps": result.request_rate,
        "achieved_qps": result.achieved_qps,
        "actual_concurrency": result.actual_concurrency,
        "input_token_throughput": result.input_token_throughput,
        "output_token_throughput": result.output_token_throughput,
        "metric_summaries_json": summaries,
        "ttft_p50": summaries["ttft_ms"]["p50"],
        "ttft_p95": summaries["ttft_ms"]["p95"],
        "ttft_p99": summaries["ttft_ms"]["p99"],
        "tpot_p50": summaries["tpot_ms"]["p50"],
        "tpot_p95": summaries["tpot_ms"]["p95"],
        "tpot_p99": summaries["tpot_ms"]["p99"],
        "e2e_p50": summaries["e2e_ms"]["p50"],
        "e2e_p95": summaries["e2e_ms"]["p95"],
        "e2e_p99": summaries["e2e_ms"]["p99"],
        "ttft_histogram_json": result.ttft_histogram().as_dict(),
        "tpot_histogram_json": result.tpot_histogram().as_dict(),
        "e2e_histogram_json": result.e2e_histogram().as_dict(),
        "finish_reasons_json": result.finish_reasons() or None,
        "error_categories_json": result.error_messages() or None,
    }


def _prepare_directory(cell: dict) -> Path:
    """The Cell's artifact directory, cleared of previous evidence.

    A re-run overwrites: last time's plan and observations must not survive to
    be mistaken for this time's. ``executor.log`` is exempt — the supervisor
    holds it open for the process currently running.
    """
    directory = (
        Path(cell["artifact_dir"])
        if cell.get("artifact_dir")
        else ARTIFACTS_ROOT / "cells" / str(cell["id"])
    )
    directory.mkdir(parents=True, exist_ok=True)
    for stale in directory.glob("*"):
        if stale.name != "executor.log" and stale.is_file():
            stale.unlink()
    return directory


async def execute(cell_id: int, db_path: Path) -> None:
    connection = store.connect(db_path)
    try:
        cell = store.get_cell(connection, cell_id)
        deployment = store.get_deployment(connection, cell["deployment_id"])
        # The URL is fixed when the supervisor starts this process. A cancelled
        # Cell may outlive a later edit to its Deployment while it shuts down.
        deployment["router_url"] = os.environ.get("LLMBENCH_TARGET_URL", deployment["router_url"])
        workload = cell["workload"]
        # The key lives in this process's environment and nowhere else — it is
        # never persisted, so an executor that does not need one never has one.
        api_key = os.environ.get(deployment["api_key_env"]) or None
        snapshot = _snapshot(cell, deployment, workload)

        directory = _prepare_directory(cell)
        # The plan is written before anything is measured, so it survives a
        # cancelled Cell: what was *going* to happen is worth keeping.
        _write_plan(directory, cell, deployment, snapshot)

        payloads = None
        if workload.get("dataset"):
            payloads = datasets.load(workload["dataset"]).payloads

        report_progress = _progress_reporter(connection, cell_id)

        open_loop = cell["mode"] == "qps"
        level = cell["level"]
        try:
            result = await run_measured_level(
                base_url=deployment["router_url"],
                model=deployment["model_name"],
                input_tokens=workload["input_tokens"],
                output_tokens=workload["output_tokens"],
                # In closed loop the level *is* the concurrency. In open loop it
                # is an offered rate, and concurrency is only the ceiling on how
                # many may be in flight at once — a ceiling the level must not be
                # mistaken for.
                concurrency=MAX_IN_FLIGHT if open_loop else int(level),
                request_rate=float(level) if open_loop else None,
                num_requests=cell["num_requests"],
                warmup_requests=WARMUP_REQUESTS,
                seed=SEED,
                api_key=api_key,
                payloads=payloads,
                progress_callback=report_progress,
            )
        except Exception as exc:
            # A failed Cell still gets a manifest: "what was attempted, and
            # how it ended" is exactly what the directory is for.
            _write_manifest(directory, cell, snapshot, None, error=str(exc))
            raise

        store.record_cell_result(connection, cell_id, _cell_result(result, snapshot))
        _write_level(directory, result)
        _write_manifest(directory, cell, snapshot, result)
    finally:
        connection.close()


def _progress_reporter(connection, cell_id: int):
    """Fold the kernel's per-request callbacks into throttled DB writes.

    The kernel reports every completed request; the page polls about once a
    second. Writing more often than that only contends with the measurement.
    Phase changes and a phase's final request are always written.
    """
    state = {"phase": None, "written_at": 0.0}

    def report(phase: str, completed: int, total: int) -> None:
        now = time.monotonic()
        phase_changed = phase != state["phase"]
        finished = total > 0 and completed >= total
        if not phase_changed and not finished and now - state["written_at"] < PROGRESS_WRITE_INTERVAL_SECONDS:
            return
        state["phase"] = phase
        state["written_at"] = now
        store.update_cell_progress(
            connection,
            cell_id,
            {
                "phase": _PHASE_LABELS.get(phase, phase),
                "completed_requests": completed,
                "total_requests": total,
            },
        )

    return report


def _write_level(directory: Path, result: LevelResult) -> None:
    """Every request this Cell made, one JSON object per line.

    Deliberately not in the database — the design keeps only distributions
    there. This is the file that makes a corrected definition recoverable
    rather than merely regrettable: percentiles, histograms and throughput can
    all be recomputed from it, and from the aggregates alone none of them can.

    No credentials and no request bodies: an observation is timings, token
    counts and an outcome.
    """
    path = directory / "level.jsonl"
    temporary = path.with_suffix(".jsonl.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for observation in result.observations:
            handle.write(json.dumps(asdict(observation), ensure_ascii=False) + "\n")
    temporary.replace(path)


def _write_plan(directory: Path, cell: dict, deployment: dict, snapshot: dict) -> None:
    """The frozen configuration, written before anything is measured.

    Separate from the manifest so it survives a cancelled Cell: what was
    *going* to happen is worth keeping even when it did not finish.
    """
    _write_json(
        directory / "plan.json",
        {
            "cell_id": cell["id"],
            "deployment": {
                "id": deployment["id"],
                "name": deployment["name"],
                "router_url": deployment["router_url"],
                "model_name": deployment["model_name"],
                "api_key_env": deployment["api_key_env"],
            },
            "snapshot": snapshot,
        },
    )


def _write_manifest(
    directory: Path,
    cell: dict,
    snapshot: dict,
    result: LevelResult | None,
    error: str | None = None,
) -> None:
    """The directory's cover sheet, written whether the Cell finished or not.

    On success it records the headline numbers; on failure it records the
    reason instead. Either way the plan and the outcome sit side by side.
    """
    outcome = (
        {
            "total_requests": result.total_requests,
            "successful_requests": result.successful_requests,
            "failed_requests": result.failed_requests,
            "duration_seconds": result.duration_seconds,
            "achieved_qps": result.achieved_qps,
        }
        if result is not None
        else {"error": error}
    )
    _write_json(
        directory / "manifest.json",
        {
            "cell_id": cell["id"],
            "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "snapshot": snapshot,
            "result": outcome,
        },
    )


def _write_json(path: Path, payload: object) -> None:
    """Written whole, then renamed.

    A reader that catches a half-written file would rather see the previous
    one than a truncated one.
    """
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def record_failure(db_path: Path, cell_id: int, exc: BaseException) -> None:
    """Leave a readable reason in a column this process owns.

    The backend only sees an exit code; the traceback is only visible here,
    and "why did my cell fail" is the first question anyone asks.
    """
    detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    try:
        connection = store.connect(db_path)
    except Exception:
        return
    try:
        store.update_cell_progress(connection, cell_id, {"error": detail})
    except Exception:
        pass
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m server.runner")
    parser.add_argument("--cell-id", type=int, required=True)
    parser.add_argument("--database", type=Path, default=None)
    args = parser.parse_args(argv)

    db_path = args.database or database_path()
    try:
        asyncio.run(execute(args.cell_id, db_path))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 — the whole point is to record anything
        record_failure(db_path, args.cell_id, exc)
        print(f"executor failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
