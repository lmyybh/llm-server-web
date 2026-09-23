"""Services and inspection runs over the HTTP API.

Inspection shares no entity with bench, and these tests hold that line: a
Service is created without a Model, a Deployment is invisible here, and nothing
about a service's model or topology affects whether it can be inspected.
"""

from __future__ import annotations

import pytest

from server import store, supervisor

PAYLOAD = {"name": "灰度服务", "router_url": "http://host:9000", "api_key_env": "LLM_API_KEY"}


@pytest.fixture(autouse=True)
def no_spawn(monkeypatch):
    monkeypatch.setattr(supervisor, "spawn_inspection", lambda db_path, run_id: 0)


@pytest.fixture
def service_id(client):
    response = client.post("/api/services", json=PAYLOAD)
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --- the entity -------------------------------------------------------------


def test_a_service_needs_four_fields_and_no_more(client):
    created = client.post("/api/services", json=PAYLOAD).json()
    assert created["name"] == "灰度服务"
    assert created["router_url"] == "http://host:9000"
    assert created["api_key_env"] == "LLM_API_KEY"
    assert created["note"] == ""
    # No model, no topology, no deployment. Inspection does not need them, and
    # asking for them would be asking the wrong question.
    assert "model_name" not in created
    assert "synthetic_input_limit" not in created


def test_two_services_may_not_share_a_name(client, service_id):
    assert client.post("/api/services", json=PAYLOAD).status_code == 409


def test_a_key_cannot_be_pasted_into_the_variable_name_field(client):
    response = client.post("/api/services", json={**PAYLOAD, "api_key_env": "sk-live-abc"})
    assert response.status_code == 422


def test_a_router_url_is_normalised_the_same_way_as_a_deployments(client):
    created = client.post(
        "/api/services", json={**PAYLOAD, "router_url": "host:9000/v1/"}
    ).json()
    assert created["router_url"] == "http://host:9000"


def test_a_service_can_be_edited(client, service_id):
    updated = client.patch(f"/api/services/{service_id}", json={"note": "生产灰度"}).json()
    assert updated["note"] == "生产灰度"


def test_an_unknown_service_is_a_404(client):
    assert client.get("/api/services/999").status_code == 404


def test_services_are_independent_of_models_and_deployments(client, service_id):
    """Nothing here references the bench side, and nothing there references this."""
    assert client.get("/api/models").json() == []
    assert client.get("/api/services").json()[0]["id"] == service_id


# --- running an inspection --------------------------------------------------


def test_starting_an_inspection_creates_a_run(client, service_id):
    response = client.post(f"/api/services/{service_id}/inspections")
    assert response.status_code == 201, response.text
    run = response.json()
    assert run["status"] in {"queued", "running"}
    assert run["cases"] == []


def test_starting_an_inspection_for_an_unknown_service_is_a_404(client):
    assert client.post("/api/services/999/inspections").status_code == 404


def test_an_inspection_records_its_suite_version(client, service_id):
    """Two inspections of different suite versions are not comparable, and the
    version is what says so."""
    connection = store.connect(client.app.state.db_path)
    try:
        run = store.create_inspection_run(connection, service_id)
        store.set_inspection_status(connection, run["id"], "running", suite_version="7")
    finally:
        connection.close()
    assert client.get(f"/api/inspections/{run['id']}").json()["suite_version"] == "7"


def test_case_results_come_back_with_their_requirement_flag(client, service_id):
    connection = store.connect(client.app.state.db_path)
    try:
        run = store.create_inspection_run(connection, service_id)
        store.record_inspection_case(
            connection,
            run["id"],
            0,
            {"case_id": "completion.non_stream", "required": True, "verdict": "PASS", "reason_code": "ok"},
        )
        store.record_inspection_case(
            connection,
            run["id"],
            1,
            {"case_id": "extensions.tools", "required": False, "verdict": "SKIPPED", "reason_code": "capability_unsupported"},
        )
    finally:
        connection.close()

    cases = client.get(f"/api/inspections/{run['id']}").json()["cases"]
    assert [case["case_id"] for case in cases] == ["completion.non_stream", "extensions.tools"]
    assert cases[0]["required"] is True
    assert cases[1]["required"] is False
    assert cases[1]["verdict"] == "SKIPPED"


def test_inspections_are_listed_newest_first(client, service_id):
    first = client.post(f"/api/services/{service_id}/inspections").json()
    second = client.post(f"/api/services/{service_id}/inspections").json()
    listed = client.get(f"/api/services/{service_id}/inspections").json()
    assert [run["id"] for run in listed] == [second["id"], first["id"]]


def test_an_unknown_inspection_is_a_404(client):
    assert client.get("/api/inspections/999").status_code == 404


# --- cancelling -------------------------------------------------------------


def test_a_running_inspection_can_be_cancelled(client, service_id):
    run = client.post(f"/api/services/{service_id}/inspections").json()
    response = client.post(f"/api/inspections/{run['id']}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"


def test_cancelling_a_finished_inspection_is_a_conflict(client, service_id):
    connection = store.connect(client.app.state.db_path)
    try:
        run = store.create_inspection_run(connection, service_id)
        store.set_inspection_status(connection, run["id"], "completed", verdict="PASS")
    finally:
        connection.close()
    assert client.post(f"/api/inspections/{run['id']}/cancel").status_code == 409


# --- reconciliation ---------------------------------------------------------


def test_a_restart_fails_whatever_was_in_flight(client, service_id):
    run = client.post(f"/api/services/{service_id}/inspections").json()

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_inspection_status(connection, run["id"], "running")
        assert store.reconcile_stale_inspections(connection) == 1
    finally:
        connection.close()

    reloaded = client.get(f"/api/inspections/{run['id']}").json()
    assert reloaded["status"] == "failed"
    assert "restarted" in reloaded["error"]


def test_an_inspection_does_not_wait_behind_a_bench_run(client, service_id, model_id_blocking):
    """Its whole value is answering "is this alright now" — queueing it behind a
    long ladder would destroy that."""
    workload = client.post(
        "/api/workloads",
        json={"name": "blocking", "kind": "synthetic", "input_tokens": 16, "output_tokens": 4},
    ).json()
    cell = client.post(
        f"/api/deployments/{model_id_blocking}/cells",
        json={"workload_id": workload["id"], "mode": "concurrency", "levels": [1], "num_requests": [1]},
    ).json()[0]
    client.post(f"/api/cells/{cell['id']}/run")
    started = client.post(f"/api/services/{service_id}/inspections")
    assert started.status_code == 201
    assert started.json()["status"] in {"queued", "running"}


@pytest.fixture
def model_id_blocking(client, deployment_payload):
    model = client.post("/api/models", json={"name": "blocking-model"}).json()
    return client.post(
        f"/api/models/{model['id']}/deployments",
        json={**deployment_payload, "router_url": "http://127.0.0.1:9"},
    ).json()["id"]
