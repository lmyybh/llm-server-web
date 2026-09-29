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
    monkeypatch.setattr(supervisor, "spawn_inspection", lambda db_path, run_id, **kwargs: 0)


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


def test_configured_cases_are_snapshotted_when_a_run_starts(client, service_id):
    catalogue = client.get("/api/inspection-cases").json()
    assert catalogue[0]["title"] == "生成接口健康检查"
    selected = [catalogue[2]["case_id"], catalogue[0]["case_id"]]
    configured = client.put(
        f"/api/services/{service_id}/inspection-cases", json={"case_ids": selected}
    )
    assert configured.status_code == 200, configured.text
    assert configured.json()["enabled_case_ids"] == [selected[1], selected[0]]

    first = client.post(f"/api/services/{service_id}/inspections").json()
    assert first["case_ids"] == [selected[1], selected[0]]
    client.put(
        f"/api/services/{service_id}/inspection-cases",
        json={"case_ids": [catalogue[1]["case_id"]]},
    )
    assert client.get(f"/api/inspections/{first['id']}").json()["case_ids"] == first["case_ids"]


def test_invalid_case_selection_is_rejected(client, service_id):
    for selected in ([], ["not-a-case"], ["health.generate", "health.generate"]):
        response = client.put(
            f"/api/services/{service_id}/inspection-cases", json={"case_ids": selected}
        )
        assert response.status_code == 422


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


def test_completed_case_evidence_is_available_before_the_run_finishes(client, service_id):
    connection = store.connect(client.app.state.db_path)
    try:
        run = store.create_inspection_run(connection, service_id)
        store.set_inspection_status(connection, run["id"], "running")
        store.record_inspection_case(
            connection, run["id"], 0,
            {"case_id": "health.generate", "required": True, "verdict": "FAIL",
             "reason_code": "assertion_failed", "message": "complete error",
             "evidence": [{"method": "GET", "url": "http://host:9000/health_generate",
                           "request_body": None, "response_body": "full response"}]},
        )
    finally:
        connection.close()

    detail = client.get(f"/api/inspections/{run['id']}").json()
    assert detail["status"] == "running"
    assert detail["completed_cases"] == 1
    assert detail["cases"][0]["evidence"][0]["response_body"] == "full response"
    listed = client.get(f"/api/services/{service_id}/inspections").json()
    assert listed[0]["completed_cases"] == 1


def test_inspections_are_listed_newest_first(client, service_id):
    first = client.post(f"/api/services/{service_id}/inspections").json()
    client.post(f"/api/inspections/{first['id']}/cancel")
    second = client.post(f"/api/services/{service_id}/inspections").json()
    listed = client.get(f"/api/services/{service_id}/inspections").json()
    assert [run["id"] for run in listed] == [second["id"], first["id"]]


def test_an_unknown_inspection_is_a_404(client):
    assert client.get("/api/inspections/999").status_code == 404


# --- deleting history -------------------------------------------------------


def test_a_finished_inspection_can_be_deleted_with_its_case_evidence(client, service_id):
    connection = store.connect(client.app.state.db_path)
    try:
        run = store.create_inspection_run(connection, service_id)
        store.record_inspection_case(connection, run["id"], 0, {
            "case_id": "health.generate", "required": True, "verdict": "PASS",
            "reason_code": "assertions_passed", "message": "",
            "evidence": [{"response_status": 200, "response_body": "ok"}],
        })
        store.set_inspection_status(connection, run["id"], "completed", verdict="PASS")
    finally:
        connection.close()

    assert client.delete(f"/api/inspections/{run['id']}").status_code == 204
    assert client.get(f"/api/inspections/{run['id']}").status_code == 404
    assert client.get(f"/api/services/{service_id}/inspections").json() == []
    connection = store.connect(client.app.state.db_path)
    try:
        assert connection.execute(
            "SELECT COUNT(*) FROM inspection_case_result WHERE inspection_run_id = ?", (run["id"],)
        ).fetchone()[0] == 0
    finally:
        connection.close()


def test_an_active_inspection_must_be_cancelled_before_deleting(client, service_id):
    run = client.post(f"/api/services/{service_id}/inspections").json()
    response = client.delete(f"/api/inspections/{run['id']}")
    assert response.status_code == 409
    assert client.get(f"/api/inspections/{run['id']}").status_code == 200


def test_deleting_an_unknown_inspection_is_a_404(client):
    assert client.delete("/api/inspections/999").status_code == 404


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


def test_default_cases_exclude_disruption(client, service_id):
    assert 'disruption.abort_storm' not in client.get(f'/api/services/{service_id}').json()['enabled_case_ids']


def test_same_target_inspections_cannot_overlap(client, service_id):
    assert client.post(f'/api/services/{service_id}/inspections').status_code == 201
    other = client.post('/api/services', json={**PAYLOAD, 'name': 'same target'}).json()
    assert client.post(f"/api/services/{other['id']}/inspections").status_code == 409
    assert client.get(f"/api/services/{other['id']}/inspections").json() == []


def test_inspection_refuses_target_with_running_benchmark(client, cell_id, deployment_payload):
    service = client.post('/api/services', json={**PAYLOAD, 'router_url': deployment_payload['router_url']}).json()
    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, 'running')
    finally:
        connection.close()
    assert client.post(f"/api/services/{service['id']}/inspections").status_code == 409


def test_queued_benchmark_waits_for_inspection(client, cell_id, deployment_payload):
    service = client.post('/api/services', json={**PAYLOAD, 'router_url': deployment_payload['router_url']}).json()
    run = client.post(f"/api/services/{service['id']}/inspections").json()
    connection = store.connect(client.app.state.db_path)
    try:
        store.queue_cell(connection, cell_id)
        assert store.startable_queued_cell_ids(connection) == []
        store.set_inspection_status(connection, run['id'], 'completed', verdict='PASS')
        assert store.startable_queued_cell_ids(connection) == [cell_id]
    finally:
        connection.close()


def test_cancelled_inspection_cannot_return_to_running(client, service_id):
    connection = store.connect(client.app.state.db_path)
    try:
        run = store.create_inspection_run(connection, service_id)
        store.cancel_inspection_run(connection, run['id'])
        assert not store.set_inspection_status(connection, run['id'], 'running')
        assert store.get_inspection_run(connection, run['id'])['status'] == 'cancelled'
    finally:
        connection.close()


def test_cancel_keeps_target_busy_until_child_exits(client, service_id, monkeypatch):
    import io
    from types import SimpleNamespace

    db_path = client.app.state.db_path
    run = client.post(f'/api/services/{service_id}/inspections').json()
    pid = 123456
    monkeypatch.setitem(supervisor._active_targets, (db_path.resolve(), pid), PAYLOAD['router_url'])
    monkeypatch.setattr(supervisor, 'terminate', lambda _pid: None)
    connection = store.connect(db_path)
    try:
        store.set_inspection_status(connection, run['id'], 'running', pid=pid)
    finally:
        connection.close()
    assert client.post(f"/api/inspections/{run['id']}/cancel").status_code == 200
    assert client.post(f'/api/services/{service_id}/inspections').status_code == 409
    resumed = []
    monkeypatch.setattr(supervisor, '_start_available', lambda path: resumed.append(path))
    supervisor._supervise_inspection(db_path, run['id'], SimpleNamespace(pid=pid, wait=lambda: -15), io.BytesIO())
    assert resumed == [db_path]
    assert client.get(f"/api/inspections/{run['id']}").json()['status'] == 'cancelled'
    assert client.post(f'/api/services/{service_id}/inspections').status_code == 201


def test_spawn_failure_is_an_execution_error_and_releases_target(client, service_id, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError('cannot spawn')
    monkeypatch.setattr(supervisor, 'spawn_inspection', fail)
    run = client.post(f'/api/services/{service_id}/inspections').json()
    assert run['status'] == 'failed'
    assert run['verdict'] == 'ERROR'
    monkeypatch.setattr(supervisor, 'spawn_inspection', lambda *args, **kwargs: 0)
    assert client.post(f'/api/services/{service_id}/inspections').status_code == 201
