"""Shared fixtures for API tests. Each test gets its own database file."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from server.app import create_app


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path / "test.db"))


@pytest.fixture(autouse=True)
def no_spawn(monkeypatch):
    """Tests decide queueing, not processes: spawning a real executor would
    make every submission test depend on a Target Service that isn't here."""
    from server import supervisor

    monkeypatch.setattr(supervisor, "submit", lambda db_path, cell_id: True)
    monkeypatch.setattr(supervisor, "spawn_inspection", lambda db_path, run_id: 0)


@pytest.fixture
def model_id(client) -> int:
    response = client.post("/api/models", json={"name": "DeepSeek-V4-Flash"})
    assert response.status_code == 201
    return response.json()["id"]


@pytest.fixture
def deployment_payload() -> dict:
    return {
        "name": "2P1D-tp8",
        "router_url": "http://172.18.16.149:9000",
        "model_name": "DeepSeek-V4-Flash-0731",
        "api_key_env": "LLM_API_KEY",
    }


@pytest.fixture
def deployment_id(client, model_id, deployment_payload) -> int:
    response = client.post(f"/api/models/{model_id}/deployments", json=deployment_payload)
    assert response.status_code == 201
    return response.json()["id"]


@pytest.fixture
def workload_id(client) -> int:
    """A synthetic workload in the global library, ready to build Cells from."""
    response = client.post(
        "/api/workloads",
        json={
            "name": "synthetic-1024-128",
            "kind": "synthetic",
            "input_tokens": 1024,
            "output_tokens": 128,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.fixture
def cell_id(client, deployment_id, workload_id) -> int:
    response = client.post(
        f"/api/deployments/{deployment_id}/cells",
        json={
            "workload_id": workload_id,
            "mode": "concurrency", "levels": [8],
            "num_requests": [16],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()[0]["id"]
