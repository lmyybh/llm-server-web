"""Model CRUD over the HTTP API."""

from __future__ import annotations

import pytest


def test_a_new_model_appears_in_the_list(client):
    client.post("/api/models", json={"name": "DeepSeek-V4-Flash", "note": "灰度"})
    body = client.get("/api/models").json()
    assert [m["name"] for m in body] == ["DeepSeek-V4-Flash"]
    assert body[0]["note"] == "灰度"


def test_creating_a_model_returns_it(client):
    response = client.post("/api/models", json={"name": "GLM-5.2"})
    assert response.status_code == 201
    assert response.json()["name"] == "GLM-5.2"
    assert response.json()["id"] > 0


def test_two_models_may_not_share_a_name(client):
    client.post("/api/models", json={"name": "GLM-5.2"})
    response = client.post("/api/models", json={"name": "GLM-5.2"})
    assert response.status_code == 409


def test_a_blank_name_is_refused(client):
    assert client.post("/api/models", json={"name": "   "}).status_code == 422


def test_a_name_is_stored_trimmed(client):
    response = client.post("/api/models", json={"name": "  GLM-5.2  "})
    assert response.json()["name"] == "GLM-5.2"


def test_an_unknown_model_is_a_404(client):
    assert client.get("/api/models/999").status_code == 404


def test_a_model_can_be_renamed_and_annotated(client, model_id):
    response = client.patch(f"/api/models/{model_id}", json={"name": "GLM-5.2", "note": "生产"})
    assert response.status_code == 200
    assert response.json()["name"] == "GLM-5.2"
    assert response.json()["note"] == "生产"


def test_a_partial_update_leaves_other_fields_alone(client, model_id):
    client.patch(f"/api/models/{model_id}", json={"note": "first"})
    client.patch(f"/api/models/{model_id}", json={"name": "renamed"})
    body = client.get(f"/api/models/{model_id}").json()
    assert body["note"] == "first"
    assert body["name"] == "renamed"


def test_renaming_onto_an_existing_name_is_a_conflict(client, model_id):
    client.post("/api/models", json={"name": "taken"})
    assert client.patch(f"/api/models/{model_id}", json={"name": "taken"}).status_code == 409


def test_the_list_reports_how_many_deployments_each_model_has(client, deployment_payload):
    """The Model list is the first thing anyone sees; it has to answer
    "where is this model actually running" without a second request."""
    empty = client.post("/api/models", json={"name": "no-deployments"}).json()
    busy = client.post("/api/models", json={"name": "with-deployments"}).json()
    client.post(f"/api/models/{busy['id']}/deployments", json=deployment_payload)

    counts = {m["name"]: m["deployment_count"] for m in client.get("/api/models").json()}
    assert counts == {"no-deployments": 0, "with-deployments": 1}
    assert empty["id"] != busy["id"]


@pytest.mark.parametrize("field", ["id", "created_at", "updated_at"])
def test_a_client_cannot_set_server_owned_fields(client, field):
    response = client.post("/api/models", json={"name": "GLM-5.2", field: 12345})
    assert response.status_code in (201, 422)
    if response.status_code == 201:
        assert response.json()[field] != 12345


def test_the_list_carries_activity_signals(client, cell_id):
    """A Model card shows life: when its Cells last ran, and whether any are
    in flight right now."""
    from server import store

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "running")
    finally:
        connection.close()

    body = client.get("/api/models").json()
    assert body[0]["active_cells"] == 1
    assert body[0]["latest_run_at"] is None

    connection = store.connect(client.app.state.db_path)
    try:
        # last_run_at is stamped when a result lands, not when status flips.
        store.record_cell_result(connection, cell_id, {})
        store.set_cell_status(connection, cell_id, "completed")
    finally:
        connection.close()

    body = client.get("/api/models").json()
    assert body[0]["active_cells"] == 0
    assert body[0]["latest_run_at"] is not None


def test_models_list_oldest_first(client):
    """Cards sort by creation time, newest in the bottom-right slot — right
    next to the create card that made it."""
    client.post("/api/models", json={"name": "older"})
    client.post("/api/models", json={"name": "newer"})
    body = client.get("/api/models").json()
    assert [m["name"] for m in body] == ["older", "newer"]


def test_deleting_a_model_cascades_to_deployments_and_cells(client, model_id, deployment_id, cell_id):
    assert client.delete(f"/api/models/{model_id}").status_code == 204
    assert client.get(f"/api/models/{model_id}").status_code == 404
    assert client.get(f"/api/deployments/{deployment_id}").status_code == 404
    assert client.get(f"/api/cells/{cell_id}").status_code == 404


def test_a_model_with_a_cell_in_flight_refuses_to_delete(client, model_id, cell_id):
    from server import store

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "queued")
    finally:
        connection.close()

    assert client.delete(f"/api/models/{model_id}").status_code == 409
    assert client.get(f"/api/models/{model_id}").status_code == 200
