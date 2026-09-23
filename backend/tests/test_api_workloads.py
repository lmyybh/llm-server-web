"""The global Workload library over the HTTP API."""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def registered(tmp_path, monkeypatch):
    """A dataset registry with one usable dataset."""
    path = tmp_path / "business.jsonl"
    path.write_text(
        json.dumps({"messages": [{"role": "user", "content": "hi"}], "max_tokens": 16}) + "\n"
    )
    config = tmp_path / "datasets.json"
    config.write_text(json.dumps({"datasets": [{"name": "business", "path": str(path)}]}))
    monkeypatch.setenv("LLMBENCH_DATASETS", str(config))
    return path


def synthetic(**overrides) -> dict:
    return {
        "name": "prefill-1k-128",
        "kind": "synthetic",
        "input_tokens": 1024,
        "output_tokens": 128,
        **overrides,
    }


def test_a_synthetic_workload_is_created(client):
    response = client.post("/api/workloads", json=synthetic())
    assert response.status_code == 201
    body = response.json()
    assert body["kind"] == "synthetic"
    assert body["input_tokens"] == 1024
    assert body["dataset"] is None


def test_a_dataset_workload_is_created(client, registered):
    response = client.post(
        "/api/workloads", json={"name": "business", "kind": "dataset", "dataset": "business"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["dataset"] == "business"


def test_a_dataset_workload_needs_a_registered_dataset(client, registered):
    response = client.post(
        "/api/workloads", json={"name": "nope", "kind": "dataset", "dataset": "unregistered"}
    )
    assert response.status_code == 422


def test_a_workload_is_exactly_one_kind(client):
    neither = client.post("/api/workloads", json={"name": "x", "kind": "synthetic"})
    assert neither.status_code == 422

    both = client.post("/api/workloads", json=synthetic(name="y", dataset="business"))
    assert both.status_code == 422

    tokens_on_a_dataset = client.post(
        "/api/workloads",
        json={"name": "z", "kind": "dataset", "dataset": "d", "input_tokens": 8},
    )
    assert tokens_on_a_dataset.status_code == 422


def test_a_synthetic_workload_needs_both_token_counts(client):
    missing_output = client.post(
        "/api/workloads",
        json={"name": "x", "kind": "synthetic", "input_tokens": 1024},
    )
    assert missing_output.status_code == 422


def test_workloads_are_global_not_per_deployment(client, workload_id):
    """The library sits outside any Deployment — no deployment id in sight."""
    listing = client.get("/api/workloads").json()
    assert any(workload["id"] == workload_id for workload in listing)


def test_a_duplicate_name_is_a_409(client, workload_id):
    response = client.post("/api/workloads", json=synthetic(name="synthetic-1024-128"))
    assert response.status_code == 409


def test_only_name_and_note_may_change(client, workload_id):
    renamed = client.patch(f"/api/workloads/{workload_id}", json={"note": "常用"})
    assert renamed.status_code == 200
    assert renamed.json()["note"] == "常用"

    # A shape edit is not ignored — it is refused. Silently dropping it would
    # leave the caller believing it took effect.
    reshaped = client.patch(f"/api/workloads/{workload_id}", json={"input_tokens": 4096})
    assert reshaped.status_code == 422


def test_a_referenced_workload_cannot_be_deleted(client, deployment_id, cell_id, workload_id):
    response = client.delete(f"/api/workloads/{workload_id}")
    assert response.status_code == 409

    # Creating the Cell attached the pair: deleting the Cell is not enough,
    # the Workload must also be removed from the Deployment.
    client.delete(f"/api/cells/{cell_id}")
    assert client.delete(f"/api/workloads/{workload_id}").status_code == 409

    client.delete(f"/api/deployments/{deployment_id}/workloads/{workload_id}")
    assert client.delete(f"/api/workloads/{workload_id}").status_code == 204


def test_the_listing_counts_references(client, cell_id, workload_id):
    workload = next(
        workload for workload in client.get("/api/workloads").json() if workload["id"] == workload_id
    )
    assert workload["cell_count"] == 1
    assert workload["deployment_count"] == 1
