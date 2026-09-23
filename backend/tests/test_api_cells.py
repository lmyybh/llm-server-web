"""Cells over the HTTP API: configuration, uniqueness, running, staleness."""

from __future__ import annotations

from server import store


def create_cells(client, deployment_id: int, workload_id: int, **overrides):
    return client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={
            "workload_id": workload_id,
            "mode": "concurrency", "levels": [1, 4, 16],
            "num_requests": [16],
            **overrides,
        },
    )


# --- configuration ----------------------------------------------------------


def test_a_level_ladder_expands_into_cells(client, deployment_id, workload_id):
    response = create_cells(client, deployment_id, workload_id)
    assert response.status_code == 201, response.text
    cells = response.json()
    assert [cell["level"] for cell in cells] == [1.0, 4.0, 16.0]
    assert all(cell["status"] == "idle" for cell in cells)
    assert all(cell["num_requests"] == 16 for cell in cells)


def test_a_single_request_count_broadcasts_across_the_ladder(client, deployment_id, workload_id):
    response = create_cells(client, deployment_id, workload_id, num_requests=[32])
    assert response.status_code == 201, response.text
    assert [cell["num_requests"] for cell in response.json()] == [32, 32, 32]


def test_several_request_counts_pair_with_the_levels_one_to_one(
    client, deployment_id, workload_id
):
    response = create_cells(
        client, deployment_id, workload_id, levels=[1, 4], num_requests=[16, 128]
    )
    assert response.status_code == 201, response.text
    cells = response.json()
    assert [(cell["level"], cell["num_requests"]) for cell in cells] == [(1.0, 16), (4.0, 128)]


def test_request_counts_must_broadcast_or_match_the_ladder(client, deployment_id, workload_id):
    response = create_cells(client, deployment_id, workload_id, num_requests=[16, 32])
    assert response.status_code == 422
    assert "one count to broadcast, or one per level" in str(response.json()["detail"])


def test_a_duplicate_mode_and_level_is_a_409(client, deployment_id, workload_id):
    assert create_cells(client, deployment_id, workload_id).status_code == 201
    again = create_cells(client, deployment_id, workload_id, levels=[4, 32])
    assert again.status_code == 409
    assert "4" in again.json()["detail"]
    # Nothing half-created: the batch is all-or-nothing.
    cells = client.get(f"/api/deployments/{deployment_id}/cells").json()
    assert len(cells) == 3


def test_the_same_cell_can_exist_under_another_deployment(
    client, model_id, deployment_payload, deployment_id, workload_id
):
    """Uniqueness is scoped to (deployment, workload, mode, level) — a second
    Deployment must be able to run the identical combination, or comparison
    would be impossible."""
    other = client.post(
        f"/api/models/{model_id}/deployments", json={**deployment_payload, "name": "3P2D-tp4"}
    ).json()
    assert create_cells(client, deployment_id, workload_id).status_code == 201
    assert create_cells(client, other["id"], workload_id).status_code == 201


def test_a_cell_over_the_deployments_generation_limit_is_refused(
    client, deployment_id, workload_id
):
    client.patch(f"/api/deployments/{deployment_id}", json={"synthetic_input_limit": 512})
    response = create_cells(client, deployment_id, workload_id)
    assert response.status_code == 422
    assert "synthetic_input_limit" in response.json()["detail"]


def test_the_limit_covers_output_tokens_too(client, deployment_id):
    """The limit guards the generation cost of a synthetic shape — a long
    *output* is at least as expensive as a long input, so both are checked."""
    workload = client.post(
        "/api/workloads",
        json={"name": "long-output", "kind": "synthetic", "input_tokens": 64, "output_tokens": 256},
    ).json()
    client.patch(f"/api/deployments/{deployment_id}", json={"synthetic_input_limit": 128})
    response = create_cells(client, deployment_id, workload["id"])
    assert response.status_code == 422
    assert "output_tokens" in response.json()["detail"]


def test_levels_must_be_positive_and_distinct(client, deployment_id, workload_id):
    assert create_cells(client, deployment_id, workload_id, levels=[0]).status_code == 422
    assert (
        create_cells(client, deployment_id, workload_id, levels=[4, 4]).status_code == 422
    )


def test_concurrency_levels_must_be_whole_numbers(client, deployment_id, workload_id):
    """Concurrency is a count of permits: 1.5 would execute as its truncation
    while the Cell claims 1.5. QPS is a rate and may stay fractional."""
    assert create_cells(client, deployment_id, workload_id, levels=[1.5]).status_code == 422
    response = create_cells(client, deployment_id, workload_id, mode="qps", levels=[0.5])
    assert response.status_code == 201
    assert response.json()[0]["level"] == 0.5


def test_num_requests_is_adjustable_and_marks_the_cell_stale(client, cell_id):
    """…but only once a result exists. Before the first run there is nothing
    to be stale against — a missing snapshot is a value of its own."""
    cell = client.get(f"/api/cells/{cell_id}").json()
    assert cell["stale"] is False

    connection = store.connect(client.app.state.db_path)
    try:
        store.record_cell_result(
            connection,
            cell_id,
            {
                "executed_snapshot_json": {
                    "num_requests": 16,
                    "mode": "concurrency",
                    "level": 8.0,
                },
                "ttft_p50": 100.0,
            },
        )
    finally:
        connection.close()

    assert client.get(f"/api/cells/{cell_id}").json()["stale"] is False

    updated = client.patch(f"/api/cells/{cell_id}", json={"num_requests": 64})
    assert updated.status_code == 200
    assert updated.json()["num_requests"] == 64
    assert updated.json()["stale"] is True


def test_mode_and_level_are_identity_not_editable(client, cell_id):
    response = client.patch(f"/api/cells/{cell_id}", json={"num_requests": 16, "level": 32})
    assert response.status_code == 422


def test_cells_are_listed_with_their_workload(client, cell_id, deployment_id):
    cells = client.get(f"/api/deployments/{deployment_id}/cells").json()
    assert len(cells) == 1
    assert cells[0]["workload_name"] == "synthetic-1024-128"
    assert cells[0]["workload_kind"] == "synthetic"


def test_an_unknown_cell_is_a_404(client):
    assert client.get("/api/cells/999").status_code == 404


def test_a_cell_can_be_deleted(client, cell_id):
    assert client.delete(f"/api/cells/{cell_id}").status_code == 204
    assert client.get(f"/api/cells/{cell_id}").status_code == 404


# --- running -----------------------------------------------------------------


def test_running_a_cell_queues_it(client, cell_id):
    response = client.post(f"/api/cells/{cell_id}/run")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "queued"


def test_a_cell_already_in_flight_refuses_to_run_again(client, cell_id):
    assert client.post(f"/api/cells/{cell_id}/run").status_code == 200
    again = client.post(f"/api/cells/{cell_id}/run")
    assert again.status_code == 409


def test_a_batch_run_queues_every_cell(client, deployment_id, workload_id):
    cells = create_cells(client, deployment_id, workload_id).json()
    ids = [cell["id"] for cell in cells]
    response = client.post("/api/cells/run", json={"cell_ids": ids})
    assert response.status_code == 200, response.text
    assert all(cell["status"] == "queued" for cell in response.json())


def test_a_batch_run_with_one_in_flight_cell_queues_nothing(client, deployment_id, workload_id):
    cells = create_cells(client, deployment_id, workload_id).json()
    ids = [cell["id"] for cell in cells]
    client.post(f"/api/cells/{ids[1]}/run")

    response = client.post("/api/cells/run", json={"cell_ids": ids})
    assert response.status_code == 409
    remaining = client.get(f"/api/deployments/{deployment_id}/cells").json()
    assert [cell["status"] for cell in remaining].count("queued") == 1


def test_cancelling_an_idle_cell_is_a_409(client, cell_id):
    assert client.post(f"/api/cells/{cell_id}/cancel").status_code == 409


def test_cancelling_a_queued_cell_needs_no_process(client, cell_id):
    client.post(f"/api/cells/{cell_id}/run")
    response = client.post(f"/api/cells/{cell_id}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"


def test_a_cancelled_cell_can_be_rerun(client, cell_id):
    client.post(f"/api/cells/{cell_id}/run")
    client.post(f"/api/cells/{cell_id}/cancel")
    assert client.post(f"/api/cells/{cell_id}/run").status_code == 200


# --- estimate -----------------------------------------------------------------


def test_an_estimate_is_returned_before_anything_runs(client, deployment_id, workload_id):
    response = client.post(
        f"/api/deployments/{deployment_id}/estimate",
        json={
            "workload_id": workload_id,
            "mode": "concurrency", "levels": [1, 8],
            "num_requests": [16],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["cell_count"] == 2
    assert body["estimated_seconds"] > 0
    assert body["latency_is_estimated"] is True


def test_an_estimate_uses_this_deployments_own_history(client, cell_id):
    connection = store.connect(client.app.state.db_path)
    try:
        store.record_cell_result(connection, cell_id, {"e2e_p50": 500.0})
        store.set_cell_status(connection, cell_id, "completed")
    finally:
        connection.close()

    cell = client.get(f"/api/cells/{cell_id}").json()
    response = client.post(
        f"/api/deployments/{cell['deployment_id']}/estimate",
        json={
            "workload_id": cell["workload_id"],
            "mode": "concurrency", "levels": [8],
            "num_requests": [16],
        },
    )
    body = response.json()
    assert body["latency_is_estimated"] is False
    assert body["latency_seconds"] == 0.5


def test_an_estimate_pairs_request_counts_with_levels(client, deployment_id, workload_id):
    response = client.post(
        f"/api/deployments/{deployment_id}/estimate",
        json={
            "workload_id": workload_id,
            "mode": "concurrency",
            "levels": [1, 8],
            "num_requests": [16, 32],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["cell_count"] == 2
    assert body["request_count"] == 48
