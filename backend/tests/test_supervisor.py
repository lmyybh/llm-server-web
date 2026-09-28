"""Process supervision: what a Cell's status becomes when its executor ends.

The backend is the only party that can observe whether a child is still
alive, which is why status is the one thing it owns.
"""

from __future__ import annotations

import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from server import store, supervisor
from server.app import create_app

# A port nothing is listening on: connecting is refused immediately, so the
# executor fails fast without a target to talk to.
DEAD_URL = "http://127.0.0.1:9"


@pytest.fixture
def live_client(tmp_path, monkeypatch):
    """A client whose cells actually spawn an executor."""
    monkeypatch.undo()  # restore supervisor.submit for real spawning
    return TestClient(create_app(tmp_path / "supervised.db"))


def wait_for_terminal(client, cell_id: int, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cell = client.get(f"/api/cells/{cell_id}").json()
        if cell["status"] in store.TERMINAL_STATUSES:
            return cell
        time.sleep(0.1)
    pytest.fail(f"cell {cell_id} never reached a terminal status")


def make_cell(client, deployment_id: int) -> dict:
    workload = client.post(
        "/api/workloads",
        json={
            "name": f"w-{deployment_id}",
            "kind": "synthetic",
            "input_tokens": 16,
            "output_tokens": 4,
        },
    ).json()
    response = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload["id"], "mode": "concurrency", "levels": [1], "num_requests": [1]},
    )
    assert response.status_code == 201, response.text
    return response.json()[0]


# --- the supervisor thread --------------------------------------------------


def supervise(db_path, cell_id: int, code: int) -> None:
    process = subprocess.Popen([sys.executable, "-c", f"raise SystemExit({code})"])
    connection = store.connect(db_path)
    try:
        if store.get_cell(connection, cell_id)["status"] == "running":
            store.set_cell_status(connection, cell_id, "running", pid=process.pid)
    finally:
        connection.close()
    log = open(db_path.parent / f"child-{cell_id}.log", "wb")
    supervisor._supervise(db_path, cell_id, process, log)


def pending_cell(client) -> tuple[int, object]:
    model = client.post("/api/models", json={"name": "m"}).json()
    deployment = client.post(
        f"/api/models/{model['id']}/deployments",
        json={"name": "d", "router_url": DEAD_URL, "model_name": "m"},
    ).json()
    connection = store.connect(client.app.state.db_path)
    try:
        workload = store.create_workload(
            connection,
            {"name": "w", "kind": "synthetic", "input_tokens": 1, "output_tokens": 1},
        )
        cell = store.create_cells(
            connection,
            deployment["id"],
            workload_id=workload["id"],
            mode="concurrency",
            levels=[1],
            num_requests=[1],
        )[0]
        store.set_cell_status(connection, cell["id"], "running")
    finally:
        connection.close()
    return cell["id"], client.app.state.db_path


def test_a_clean_exit_completes_the_cell(client):
    cell_id, db_path = pending_cell(client)
    supervise(db_path, cell_id, 0)
    cell = client.get(f"/api/cells/{cell_id}").json()
    assert cell["status"] == "completed"
    assert cell["error"] is None
    assert cell["started_at"] is not None
    assert cell["finished_at"] is not None


def test_a_failed_exit_fails_the_cell_with_its_code(client):
    cell_id, db_path = pending_cell(client)
    supervise(db_path, cell_id, 3)
    cell = client.get(f"/api/cells/{cell_id}").json()
    assert cell["status"] == "failed"
    assert "3" in cell["error"]


def test_a_cancelled_cell_is_not_overwritten_by_the_supervisor(client):
    """Cancel gets the last word — otherwise a killed executor would tidy
    itself back into `completed`."""
    cell_id, db_path = pending_cell(client)
    connection = store.connect(db_path)
    try:
        store.set_cell_status(connection, cell_id, "cancelled")
    finally:
        connection.close()

    supervise(db_path, cell_id, 0)
    assert client.get(f"/api/cells/{cell_id}").json()["status"] == "cancelled"


def test_old_child_cannot_complete_a_newly_queued_rerun(client, monkeypatch):
    cell_id, db_path = pending_cell(client)
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    connection = store.connect(db_path)
    try:
        store.set_cell_status(connection, cell_id, "running", pid=process.pid)
        store.set_cell_status(connection, cell_id, "cancelled")
        store.queue_cell(connection, cell_id)
    finally:
        connection.close()

    monkeypatch.setattr(supervisor, "_start_available", lambda _db_path: [])
    log = open(db_path.parent / "old-child.log", "wb")
    supervisor._supervise(db_path, cell_id, process, log)
    assert client.get(f"/api/cells/{cell_id}").json()["status"] == "queued"


def test_queued_cells_run_in_enqueue_order_across_deployments(client, model_id, deployment_id, workload_id, monkeypatch):
    target_url = client.get(f"/api/deployments/{deployment_id}").json()["router_url"]
    other = client.post(
        f"/api/models/{model_id}/deployments",
        json={"name": "other", "router_url": target_url, "model_name": "m"},
    ).json()
    first_created = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [1], "num_requests": [1]},
    ).json()[0]
    later_created = client.post(
        f"/api/deployments/{other['id']}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [1], "num_requests": [1]},
    ).json()[0]
    db_path = client.app.state.db_path
    monkeypatch.setattr(store, "_now", lambda: "2026-09-28T00:00:00+00:00")
    connection = store.connect(db_path)
    try:
        store.queue_cell(connection, later_created["id"])
        store.queue_cell(connection, first_created["id"])
    finally:
        connection.close()

    started = []
    monkeypatch.setattr(supervisor, "_start", lambda _db_path, cell_id: started.append(cell_id))
    supervisor._start_next(db_path)
    assert started == [later_created["id"]]

    connection = store.connect(db_path)
    try:
        store.set_cell_status(connection, later_created["id"], "running")
        assert store.next_queued_cell_id(connection) == first_created["id"]
        store.set_cell_status(connection, later_created["id"], "completed")
        store.queue_cell(connection, later_created["id"])
        assert store.next_queued_cell_id(connection) == first_created["id"]
    finally:
        connection.close()


def test_submit_starts_the_oldest_ticket_even_when_called_for_a_later_one(client, deployment_id, workload_id, monkeypatch):
    cells = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [1, 2], "num_requests": [1]},
    ).json()
    db_path = client.app.state.db_path
    connection = store.connect(db_path)
    try:
        store.queue_cell(connection, cells[1]["id"])
        store.queue_cell(connection, cells[0]["id"])
    finally:
        connection.close()

    monkeypatch.undo()  # restore the real submit, then stub process creation
    started = []
    monkeypatch.setattr(supervisor, "_start", lambda _db_path, cell_id: started.append(cell_id))
    assert supervisor.submit(db_path, cells[0]["id"]) is False
    assert started == [cells[1]["id"]]


@pytest.mark.parametrize("same_model", [True, False])
def test_different_urls_start_in_parallel(client, model_id, deployment_id, workload_id, monkeypatch, same_model):
    target_model_id = model_id if same_model else client.post(
        "/api/models", json={"name": "other model"}
    ).json()["id"]
    other = client.post(
        f"/api/models/{target_model_id}/deployments",
        json={"name": "other", "router_url": DEAD_URL, "model_name": "m"},
    ).json()
    cells = [
        client.post(
            f"/api/deployments/{deployment}/cells",
            json={"workload_id": workload_id, "mode": "concurrency", "levels": [1], "num_requests": [1]},
        ).json()[0]
        for deployment in (deployment_id, other["id"])
    ]
    db_path = client.app.state.db_path
    monkeypatch.undo()
    started = []

    def mark_running(_db_path, cell_id):
        started.append(cell_id)
        connection = store.connect(db_path)
        try:
            store.set_cell_status(connection, cell_id, "running")
        finally:
            connection.close()

    monkeypatch.setattr(supervisor, "_start", mark_running)
    connection = store.connect(db_path)
    try:
        store.queue_cell(connection, cells[0]["id"])
    finally:
        connection.close()
    assert supervisor.submit(db_path, cells[0]["id"]) is True
    connection = store.connect(db_path)
    try:
        store.queue_cell(connection, cells[1]["id"])
    finally:
        connection.close()
    assert supervisor.submit(db_path, cells[1]["id"]) is True
    assert started == [cell["id"] for cell in cells]


def test_same_url_is_serial_even_across_models(client, deployment_id, workload_id, monkeypatch):
    target_url = client.get(f"/api/deployments/{deployment_id}").json()["router_url"]
    other_model = client.post("/api/models", json={"name": "other model"}).json()
    other = client.post(
        f"/api/models/{other_model['id']}/deployments",
        json={"name": "other", "router_url": target_url, "model_name": "m"},
    ).json()
    cells = [
        client.post(
            f"/api/deployments/{deployment}/cells",
            json={"workload_id": workload_id, "mode": "concurrency", "levels": [1], "num_requests": [1]},
        ).json()[0]
        for deployment in (deployment_id, other["id"])
    ]
    db_path = client.app.state.db_path
    monkeypatch.undo()
    started = []

    def mark_running(_db_path, cell_id):
        started.append(cell_id)
        connection = store.connect(db_path)
        try:
            store.set_cell_status(connection, cell_id, "running")
        finally:
            connection.close()

    monkeypatch.setattr(supervisor, "_start", mark_running)
    connection = store.connect(db_path)
    try:
        for cell in cells:
            store.queue_cell(connection, cell["id"])
    finally:
        connection.close()
    supervisor.submit(db_path, cells[1]["id"])
    assert started == [cells[0]["id"]]
    supervisor._start_next(db_path)
    assert started == [cells[0]["id"]]

    connection = store.connect(db_path)
    try:
        store.set_cell_status(connection, cells[0]["id"], "completed")
    finally:
        connection.close()
    supervisor._start_next(db_path)
    assert started == [cell["id"] for cell in cells]


def test_cancelled_child_keeps_its_url_busy_until_it_exits(client, deployment_id, workload_id, monkeypatch):
    cells = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [1, 2], "num_requests": [1]},
    ).json()
    db_path = client.app.state.db_path
    target_url = client.get(f"/api/deployments/{deployment_id}").json()["router_url"]
    connection = store.connect(db_path)
    try:
        for cell in cells:
            store.queue_cell(connection, cell["id"])
        store.set_cell_status(connection, cells[0]["id"], "running")
        store.set_cell_status(connection, cells[0]["id"], "cancelled")
    finally:
        connection.close()

    started = []
    monkeypatch.setattr(supervisor, "_start", lambda _db_path, cell_id: started.append(cell_id))
    key = (db_path.resolve(), 123456)
    supervisor._active_targets[key] = target_url
    try:
        supervisor._start_next(db_path)
        assert started == []
    finally:
        supervisor._active_targets.pop(key, None)
    supervisor._start_next(db_path)
    assert started == [cells[1]["id"]]


# --- spawning for real ------------------------------------------------------


def test_spawning_against_an_unreachable_target_fails_the_cell(live_client):
    """Exercises the whole path — spawn, runner, error recording, supervision —
    without needing a live service."""
    model = live_client.post("/api/models", json={"name": "m"}).json()
    deployment = live_client.post(
        f"/api/models/{model['id']}/deployments",
        json={"name": "dead", "router_url": DEAD_URL, "model_name": "m"},
    ).json()
    cell = make_cell(live_client, deployment["id"])

    response = live_client.post(f"/api/cells/{cell['id']}/run")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "running"
    assert response.json()["pid"] > 0

    finished = wait_for_terminal(live_client, cell["id"])
    assert finished["status"] == "failed"
    assert "executor exited" in finished["error"]
    # The reason lives in a column the executor owns: the backend only saw an
    # exit code, the traceback only exists over there.
    assert finished["progress"]["error"]


def test_a_restart_fails_in_flight_cells_and_releases_queued_ones(client):
    """A backend restart orphans running executors; the reconcile pass at app
    construction is what keeps `running` from meaning 'stuck for ever'.
    Queued cells never started, so they simply go back to idle."""
    model = client.post("/api/models", json={"name": "m"}).json()
    deployment = client.post(
        f"/api/models/{model['id']}/deployments",
        json={"name": "d", "router_url": DEAD_URL, "model_name": "m"},
    ).json()
    workload = client.post(
        "/api/workloads",
        json={"name": "w", "kind": "synthetic", "input_tokens": 1, "output_tokens": 1},
    ).json()
    cells = client.post(
        f"/api/deployments/{deployment['id']}/cells",
        json={"workload_id": workload["id"], "mode": "concurrency", "levels": [1, 2], "num_requests": [1]},
    ).json()
    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cells[0]["id"], "running")
        store.queue_cell(connection, cells[1]["id"])
    finally:
        connection.close()

    restarted = TestClient(create_app(client.app.state.db_path))
    assert restarted.get(f"/api/cells/{cells[0]['id']}").json()["status"] == "failed"
    assert restarted.get(f"/api/cells/{cells[1]['id']}").json()["status"] == "idle"


def test_requeueing_clears_the_previous_runs_progress(client):
    """A cancelled Cell keeps its last progress update; without a reset the
    page would show it as the new run's until the executor's first write."""
    model = client.post("/api/models", json={"name": "m"}).json()
    deployment = client.post(
        f"/api/models/{model['id']}/deployments",
        json={"name": "d", "router_url": DEAD_URL, "model_name": "m"},
    ).json()
    cell = make_cell(client, deployment["id"])
    connection = store.connect(client.app.state.db_path)
    try:
        store.update_cell_progress(
            connection,
            cell["id"],
            {"phase": "测量", "completed_requests": 23, "total_requests": 64},
        )
        store.set_cell_status(connection, cell["id"], "cancelled")
        store.queue_cell(connection, cell["id"])
    finally:
        connection.close()

    queued = client.get(f"/api/cells/{cell['id']}").json()
    assert queued["status"] == "queued"
    assert queued["progress"] is None
