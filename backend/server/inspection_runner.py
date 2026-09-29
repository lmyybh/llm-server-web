"""The inspection executor subprocess: one process per Inspection Run.

Inspections start immediately only when their target is free. Benchmark and
inspection processes targeting the same URL cannot overlap.

Writes the case results and progress; the backend owns the status, as with a
bench Run.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import traceback
from pathlib import Path

from llmbench.inspection import SUITE_VERSION, ERROR, run_inspection

from . import store
from .config import database_path


async def execute(inspection_run_id: int, db_path: Path) -> None:
    connection = store.connect(db_path)
    try:
        run = store.get_inspection_run(connection, inspection_run_id)
        if run["status"] in store.TERMINAL_STATUSES:
            return
        service = store.get_service(connection, run["service_id"])
        # Read here, from this process's environment, and never persisted.
        api_key = os.environ.get(os.environ.get("LLMBENCH_INSPECTION_KEY_ENV", service["api_key_env"])) or None

        def on_event(event: dict) -> None:
            if event["type"] == "discovered":
                store.set_inspection_status(
                    connection,
                    inspection_run_id,
                    "running",
                    suite_version=SUITE_VERSION,
                    target=event["target"],
                )
            elif event["type"] == "case_started":
                store.update_inspection_progress(
                    connection, inspection_run_id, current_case=event["case_id"]
                )
            elif event["type"] == "case_finished":
                store.record_inspection_case(
                    connection, inspection_run_id, event["ordinal"],
                    {**event["case"], "evidence": event["evidence"]},
                )

        summary = await run_inspection(
            os.environ.get("LLMBENCH_INSPECTION_TARGET_URL", service["router_url"]),
            api_key=api_key, on_event=on_event,
            selected_case_ids=run["case_ids"],
            case_timeouts={c["case_id"]: c["timeout_seconds"] for c in run["case_settings"]},
        )

        # Also cover discovery failure and preserve evidence already written
        # for completed cases if a final result needs to be reconciled.
        for ordinal, case in enumerate(summary.cases):
            store.record_inspection_case(connection, inspection_run_id, ordinal, case.as_dict())

        discovery_failed = summary.target is None
        store.set_inspection_status(
            connection,
            inspection_run_id,
            "failed" if discovery_failed else "completed",
            verdict=summary.run_verdict,
            suite_version=SUITE_VERSION,
            error=(
                summary.cases[0].message if discovery_failed and summary.cases else None
            ),
        )
    finally:
        connection.close()


def record_failure(db_path: Path, inspection_run_id: int, exc: BaseException) -> None:
    detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    try:
        connection = store.connect(db_path)
    except Exception:
        return
    try:
        store.set_inspection_status(
            connection, inspection_run_id, "failed", error=detail, verdict=ERROR
        )
    except Exception:
        pass
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m server.inspection_runner")
    parser.add_argument("--inspection-run-id", type=int, required=True)
    parser.add_argument("--database", type=Path, default=None)
    args = parser.parse_args(argv)

    db_path = args.database or database_path()
    try:
        asyncio.run(execute(args.inspection_run_id, db_path))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 — record anything rather than lose it
        record_failure(db_path, args.inspection_run_id, exc)
        print(f"inspector failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
