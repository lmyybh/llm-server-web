"""Business datasets: the registry, and dataset-backed Workloads."""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def registered(tmp_path, monkeypatch):
    """A registry with one usable dataset and one whose file has gone missing."""
    path = tmp_path / "business.jsonl"
    path.write_text(
        json.dumps({"messages": [{"role": "user", "content": "hi"}], "max_tokens": 16}) + "\n"
    )
    config = tmp_path / "datasets.json"
    config.write_text(
        json.dumps(
            {
                "datasets": [
                    {"name": "business", "path": str(path)},
                    {"name": "moved", "path": str(tmp_path / "gone.jsonl")},
                ]
            }
        )
    )
    monkeypatch.setenv("LLMBENCH_DATASETS", str(config))
    return path


def test_registered_datasets_are_listed(client, registered):
    datasets = client.get("/api/datasets").json()
    by_name = {entry["name"]: entry for entry in datasets}
    assert by_name["business"]["exists"] is True
    assert by_name["moved"]["exists"] is False


def test_no_registry_at_all_is_an_empty_list(client, monkeypatch, tmp_path):
    monkeypatch.setenv("LLMBENCH_DATASETS", str(tmp_path / "absent.json"))
    assert client.get("/api/datasets").json() == []


def test_a_dataset_workload_joins_the_library(client, registered):
    response = client.post(
        "/api/workloads", json={"name": "biz", "kind": "dataset", "dataset": "business"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["kind"] == "dataset"


def test_an_unregistered_dataset_is_refused_with_the_reason(client, registered):
    response = client.post(
        "/api/workloads", json={"name": "nope", "kind": "dataset", "dataset": "unregistered"}
    )
    assert response.status_code == 422
    assert "unregistered" in response.json()["detail"]


def test_a_dataset_whose_file_vanished_is_refused(client, registered):
    response = client.post(
        "/api/workloads", json={"name": "gone", "kind": "dataset", "dataset": "moved"}
    )
    assert response.status_code == 422


def test_a_dataset_workload_is_not_subject_to_the_generation_limit(
    client, deployment_id, registered
):
    client.patch(f"/api/deployments/{deployment_id}", json={"synthetic_input_limit": 8})
    workload = client.post(
        "/api/workloads", json={"name": "biz", "kind": "dataset", "dataset": "business"}
    ).json()
    response = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={"workload_id": workload["id"], "mode": "concurrency", "levels": [4]},
    )
    assert response.status_code == 201, response.text
