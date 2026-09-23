"""Adding a Workload to a Deployment without configuring any Cell."""

from __future__ import annotations


def attach(client, deployment_id: int, workload_id: int):
    return client.put(f"/api/deployments/{deployment_id}/workloads/{workload_id}")


def test_a_deployment_starts_with_no_workloads(client, deployment_id):
    response = client.get(f"/api/deployments/{deployment_id}/workloads")
    assert response.status_code == 200
    assert response.json() == []


def test_attaching_adds_the_workload_without_creating_cells(client, deployment_id, workload_id):
    response = attach(client, deployment_id, workload_id)
    assert response.status_code == 201
    assert response.json()["id"] == workload_id

    listed = client.get(f"/api/deployments/{deployment_id}/workloads").json()
    assert [workload["id"] for workload in listed] == [workload_id]
    assert client.get(f"/api/deployments/{deployment_id}/cells").json() == []


def test_attaching_twice_conflicts(client, deployment_id, workload_id):
    assert attach(client, deployment_id, workload_id).status_code == 201
    assert attach(client, deployment_id, workload_id).status_code == 409


def test_attaching_unknown_ids_is_a_404(client, deployment_id, workload_id):
    assert attach(client, deployment_id, 999).status_code == 404
    assert attach(client, 999, workload_id).status_code == 404


def test_creating_the_first_cell_attaches_implicitly(client, deployment_id, workload_id):
    response = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [8], "num_requests": [64]},
    )
    assert response.status_code == 201
    listed = client.get(f"/api/deployments/{deployment_id}/workloads").json()
    assert [workload["id"] for workload in listed] == [workload_id]


def test_detaching_removes_the_attachment(client, deployment_id, workload_id):
    attach(client, deployment_id, workload_id)
    response = client.delete(f"/api/deployments/{deployment_id}/workloads/{workload_id}")
    assert response.status_code == 204
    assert client.get(f"/api/deployments/{deployment_id}/workloads").json() == []


def test_detaching_something_never_attached_is_a_404(client, deployment_id, workload_id):
    response = client.delete(f"/api/deployments/{deployment_id}/workloads/{workload_id}")
    assert response.status_code == 404


def test_detaching_is_blocked_while_cells_reference_the_pair(client, deployment_id, workload_id):
    client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [8], "num_requests": [64]},
    )
    response = client.delete(f"/api/deployments/{deployment_id}/workloads/{workload_id}")
    assert response.status_code == 409
    assert "cell" in response.json()["detail"]


def test_a_workload_cannot_be_deleted_while_attached(client, deployment_id, workload_id):
    attach(client, deployment_id, workload_id)
    response = client.delete(f"/api/workloads/{workload_id}")
    assert response.status_code == 409
    assert "deployment" in response.json()["detail"]

    client.delete(f"/api/deployments/{deployment_id}/workloads/{workload_id}")
    assert client.delete(f"/api/workloads/{workload_id}").status_code == 204


def test_an_attachment_counts_toward_deployment_count(client, deployment_id, workload_id):
    attach(client, deployment_id, workload_id)
    workload = next(
        workload for workload in client.get("/api/workloads").json() if workload["id"] == workload_id
    )
    assert workload["deployment_count"] == 1
    assert workload["cell_count"] == 0
