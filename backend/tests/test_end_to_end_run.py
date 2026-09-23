"""A real Cell, end to end: configure → queue → spawn → measure → read back.

Everything else stubs the spawn or the target. This is the only test that
proves the whole chain actually runs, so it talks to a real Target Service.
It skips when that service is unreachable rather than failing, because the
suite should still be runnable offline.

Kept deliberately small — a handful of short requests against a service other
people may be using.
"""

from __future__ import annotations

import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from server import store
from server.app import create_app

TARGET_URL = os.environ.get(
    "LLMBENCH_TEST_URL",
    "http://maas-infer-service-wlcb-gray-dpsk-v4-flash-default-alb-pre.kanzhun-inc.com",
)
TARGET_MODEL = os.environ.get("LLMBENCH_TEST_MODEL", "DeepSeek-V4-Flash-0731")


@pytest.fixture(scope="module")
def target() -> tuple[str, str]:
    try:
        response = httpx.get(f"{TARGET_URL}/v1/models", timeout=5.0)
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 — any failure means "cannot test here"
        pytest.skip(f"target {TARGET_URL} is unreachable: {exc}")
    return TARGET_URL, TARGET_MODEL


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.undo()  # real spawning: restore supervisor.submit
    return TestClient(create_app(tmp_path / "e2e.db"))


def wait_for_terminal(client, cell_id: int, timeout: float = 180.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cell = client.get(f"/api/cells/{cell_id}").json()
        if cell["status"] in store.TERMINAL_STATUSES:
            return cell
        time.sleep(0.25)
    pytest.fail(f"cell {cell_id} never finished")


def test_a_small_cell_against_a_real_service_produces_readable_metrics(client, target):
    url, model = target
    model_row = client.post("/api/models", json={"name": model}).json()
    deployment = client.post(
        f"/api/models/{model_row['id']}/deployments",
        json={"name": "e2e", "router_url": url, "model_name": model},
    ).json()
    workload = client.post(
        "/api/workloads",
        json={
            "name": "e2e-128-16",
            "kind": "synthetic",
            "input_tokens": 128,
            "output_tokens": 16,
        },
    ).json()
    cell = client.post(
        f"/api/deployments/{deployment['id']}/cells",
        json={
            "workload_id": workload["id"],
            "mode": "concurrency", "levels": [2],
            "num_requests": [4],
        },
    ).json()[0]

    started = client.post(f"/api/cells/{cell['id']}/run")
    assert started.status_code == 200, started.text

    finished = wait_for_terminal(client, cell["id"])
    assert finished["status"] == "completed", finished["error"]
    assert finished["total_requests"] == 4
    assert finished["successful_requests"] == 4
    assert finished["ttft_p50"] > 0
    assert finished["e2e_p50"] >= finished["ttft_p50"]
    assert finished["output_token_throughput"] > 0
    assert finished["last_run_at"] is not None

    snapshot = finished["executed_snapshot"]
    assert snapshot["num_requests"] == 4
    assert snapshot["warmup_requests"] == 5
    assert snapshot["flush_cache"] is True
    assert snapshot["workload"]["name"] == "e2e-128-16"

    # The artifact directory carries the per-request evidence.
    artifacts = client.get(f"/api/cells/{cell['id']}/artifacts").json()
    names = {entry["name"] for entry in artifacts["files"]}
    assert {"plan.json", "level.jsonl", "manifest.json", "executor.log"} <= names
