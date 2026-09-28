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


def spawn_inspection(db_path: Path, inspection_run_id: int) -> int:
    """Start an inspector.

    Deliberately **not** put through the queue. An inspection is short, and its
    whole value is answering "is this service alright right now" — waiting
    behind a forty-minute sweep would make it useless for that.
    """
    directory = artifact_dir(inspection_run_id, kind="inspections")
    log = open(directory / "executor.log", "wb")  # noqa: SIM115 — handed to the thread
    environment = {**os.environ, "LLMBENCH_DB": str(db_path)}

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
    returncode = process.wait()
    log.close()
    if returncode == 0:
        # The inspector recorded its own verdict; there is nothing to add.
        return
    connection = store.connect(db_path)
    try:
        store.set_inspection_status(
            connection,
            inspection_run_id,
            "failed",
            error=f"inspector exited with code {returncode}",
        )
    finally:
        connection.close()


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


def terminate(pid: int) -> None:
    """Kill an executor and everything it started.

    The child is its own session leader, so one call reaches the whole group —
    the load generator's connection pool has no other way to be stopped.
    """
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
