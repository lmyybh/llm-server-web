"""Spawning and supervising executor subprocesses.

The backend is the only thing that can observe whether an executor is still
alive, so the backend is what writes a Cell's status. The executor writes
everything else. That split is why no lock is needed on the database.

A child is put in its own session (``start_new_session``) so that cancelling a
Cell can signal the whole process group rather than hoping one PID is enough.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

from . import store
from .config import ARTIFACTS_ROOT, BACKEND_ROOT


def artifact_dir(target_id: int, kind: str = "cells") -> Path:
    """The artifact directory for a measurement — a Cell's, or an inspection's."""
    path = ARTIFACTS_ROOT / kind / str(target_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def start_inspection(db_path: Path, service_id: int) -> dict:
    """Reserve a target atomically with benchmark scheduling; never wait behind it."""
    with _queue_lock:
        connection = store.connect(db_path)
        try:
            service = store.get_service(connection, service_id)
            target = service["router_url"]
            busy = store.active_inspection_urls(connection)
            busy.update(
                url for (active_db, _), url in _active_targets.items()
                if active_db == db_path.resolve()
            )
            busy.update(row["router_url"] for row in connection.execute(
                """SELECT d.router_url FROM cell AS c
                   JOIN deployment AS d ON d.id = c.deployment_id WHERE c.status = 'running'"""
            ))
            if target in busy:
                raise store.Conflict("目标正在压测或巡检，请等待当前任务结束后重试。")
            run = store.create_inspection_run(connection, service_id)
            try:
                spawn_inspection(db_path, run["id"], service=service)
            except Exception as exc:
                store.set_inspection_status(
                    connection, run["id"], "failed", verdict="ERROR", error=f"inspector could not start: {exc}"
                )
            return store.get_inspection_run(connection, run["id"])
        finally:
            connection.close()


def spawn_inspection(db_path: Path, inspection_run_id: int, *, service: dict | None = None) -> int:
    """Start an inspector on a reserved target. Caller holds _queue_lock."""
    if service is None:
        connection = store.connect(db_path)
        try:
            run = store.get_inspection_run(connection, inspection_run_id)
            service = store.get_service(connection, run["service_id"])
        finally:
            connection.close()
    target_url = service["router_url"]
    directory = artifact_dir(inspection_run_id, kind="inspections")
    log = open(directory / "executor.log", "wb")  # noqa: SIM115 — handed to the thread
    environment = {
        **os.environ, "LLMBENCH_DB": str(db_path),
        "LLMBENCH_INSPECTION_TARGET_URL": target_url,
        "LLMBENCH_INSPECTION_KEY_ENV": service["api_key_env"],
    }

    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "server.inspection_runner",
                "--inspection-run-id",
                str(inspection_run_id),
            ],
            cwd=BACKEND_ROOT,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except Exception:
        log.close()
        raise
    _active_targets[(db_path.resolve(), process.pid)] = target_url

    connection = store.connect(db_path)
    try:
        store.set_inspection_status(connection, inspection_run_id, "running", pid=process.pid)
    finally:
        connection.close()

    threading.Thread(
        target=_supervise_inspection,
        args=(db_path, inspection_run_id, process, log),
        name=f"supervise-inspection-{inspection_run_id}",
        daemon=True,
    ).start()
    return process.pid


def _supervise_inspection(db_path: Path, inspection_run_id: int, process, log) -> None:
    try:
        returncode = process.wait()
        log.close()
        connection = store.connect(db_path)
        try:
            # A clean exit without a terminal record is also an execution error.
            store.set_inspection_status(
                connection, inspection_run_id, "failed", verdict="ERROR",
                error=f"inspector exited with code {returncode} without a completed result",
            )
        finally:
            connection.close()
    finally:
        with _queue_lock:
            _active_targets.pop((db_path.resolve(), process.pid), None)
            _start_available(db_path)


_queue_lock = threading.Lock()
"""Serialises the decision to start an executor.

Cells targeting the same URL run one at a time: concurrent load generators
would pollute each other's numbers. Different URLs may run in parallel. The
lock covers the *decision*, not the Cell's execution.
"""
_active_targets: dict[tuple[Path, int], str] = {}
"""Keep a URL busy until its child actually exits, including after cancel."""


def submit(db_path: Path, cell_id: int) -> bool:
    """Start the oldest queued Cell for every free target URL.

    Returns whether the submitted Cell started. A Cell that does not start
    stays `queued` until earlier work for its URL finishes.
    """
    with _queue_lock:
        return cell_id in _start_available(db_path)


def _start_available(db_path: Path) -> list[int]:
    connection = store.connect(db_path)
    try:
        blocked_urls = {
            url for (active_db, _), url in _active_targets.items()
            if active_db == db_path.resolve()
        }
        cell_ids = store.startable_queued_cell_ids(connection, blocked_urls)
    finally:
        connection.close()
    for cell_id in cell_ids:
        _start(db_path, cell_id)
    return cell_ids


def _start_next(db_path: Path) -> None:
    with _queue_lock:
        _start_available(db_path)


def _start(db_path: Path, cell_id: int) -> int:
    """Spawn the executor and mark the Cell running. Caller holds the lock."""
    connection = store.connect(db_path)
    try:
        cell = store.get_cell(connection, cell_id)
        target_url = store.get_deployment(connection, cell["deployment_id"])["router_url"]
    finally:
        connection.close()
    directory = artifact_dir(cell_id)
    log = open(directory / "executor.log", "wb")  # noqa: SIM115 — handed to the thread
    environment = {
        **os.environ,
        "LLMBENCH_DB": str(db_path),
        "LLMBENCH_TARGET_URL": target_url,
    }

    process = subprocess.Popen(
        [sys.executable, "-m", "server.runner", "--cell-id", str(cell_id)],
        cwd=BACKEND_ROOT,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    _active_targets[(db_path.resolve(), process.pid)] = target_url

    connection = store.connect(db_path)
    try:
        store.set_cell_status(
            connection, cell_id, "running", artifact_dir=str(directory), pid=process.pid
        )
    finally:
        connection.close()

    threading.Thread(
        target=_supervise,
        args=(db_path, cell_id, process, log),
        name=f"supervise-cell-{cell_id}",
        daemon=True,
    ).start()
    return process.pid


def _supervise(db_path: Path, cell_id: int, process: subprocess.Popen, log) -> None:
    returncode = process.wait()
    log.close()

    try:
        connection = store.connect(db_path)
        try:
            # The write is guarded in SQL, so a cancel that lands at the same moment
            # wins outright rather than depending on which thread got here first.
            if returncode == 0:
                store.set_cell_status(
                    connection, cell_id, "completed", expected_pid=process.pid
                )
            else:
                store.set_cell_status(
                    connection,
                    cell_id,
                    "failed",
                    error=f"executor exited with code {returncode}",
                    expected_pid=process.pid,
                )
        finally:
            connection.close()
    finally:
        # A cancelled Cell remains busy until its process has really exited.
        with _queue_lock:
            _active_targets.pop((db_path.resolve(), process.pid), None)
            _start_available(db_path)


def cancel(db_path: Path, cell_id: int) -> bool:
    """Stop a Cell. Returns False if it had already finished.

    Status is written **before** the signal, so the supervisor thread — which
    is about to see its child die — finds a terminal status and leaves it
    alone instead of filing the death as a failure.
    """
    connection = store.connect(db_path)
    try:
        pid = store.get_cell(connection, cell_id)["pid"]
        cancelled = store.cancel_cell(connection, cell_id)
    finally:
        connection.close()

    if cancelled and pid:
        terminate(pid)
    return cancelled


def cancel_inspection(db_path: Path, inspection_run_id: int) -> bool:
    # Wait for startup to publish the PID before cancellation can read it.
    with _queue_lock:
        connection = store.connect(db_path)
        try:
            run = store.get_inspection_run(connection, inspection_run_id)
            cancelled = store.cancel_inspection_run(connection, inspection_run_id)
        finally:
            connection.close()
        if cancelled and run["pid"]:
            terminate(run["pid"])
        return cancelled


def terminate(pid: int) -> None:
    """Kill an executor and everything it started.

    The child is its own session leader, so one call reaches the whole group —
    the load generator's connection pool has no other way to be stopped.
    """
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
