"""Deployment CRUD, and the credential discipline that goes with it."""

from __future__ import annotations

import json

import pytest


# --- identity ---------------------------------------------------------------


def test_a_deployment_is_created_under_its_model(client, model_id, deployment_payload):
    response = client.post(f"/api/models/{model_id}/deployments", json=deployment_payload)
    assert response.status_code == 201
    assert response.json()["model_id"] == model_id
    assert response.json()["name"] == "2P1D-tp8"


def test_a_deployment_cannot_be_created_under_an_unknown_model(client, deployment_payload):
    assert client.post("/api/models/999/deployments", json=deployment_payload).status_code == 404


def test_deployments_are_listed_per_model(client, model_id, deployment_payload):
    other = client.post("/api/models", json={"name": "other"}).json()["id"]
    client.post(f"/api/models/{model_id}/deployments", json=deployment_payload)
    client.post(f"/api/models/{other}/deployments", json={**deployment_payload, "name": "elsewhere"})

    names = [d["name"] for d in client.get(f"/api/models/{model_id}/deployments").json()]
    assert names == ["2P1D-tp8"]


def test_one_model_may_have_several_deployments(client, model_id, deployment_payload):
    """The whole point of the layer: one model, several serving configurations."""
    client.post(f"/api/models/{model_id}/deployments", json=deployment_payload)
    client.post(
        f"/api/models/{model_id}/deployments",
        json={**deployment_payload, "name": "3P2D-tp4", "topology": "3P2D"},
    )
    names = {d["name"] for d in client.get(f"/api/models/{model_id}/deployments").json()}
    assert names == {"2P1D-tp8", "3P2D-tp4"}


def test_two_deployments_of_one_model_may_not_share_a_name(client, model_id, deployment_payload):
    client.post(f"/api/models/{model_id}/deployments", json=deployment_payload)
    assert client.post(f"/api/models/{model_id}/deployments", json=deployment_payload).status_code == 409


def test_the_same_deployment_name_may_exist_under_different_models(client, model_id, deployment_payload):
    other = client.post("/api/models", json={"name": "other"}).json()["id"]
    client.post(f"/api/models/{model_id}/deployments", json=deployment_payload)
    response = client.post(f"/api/models/{other}/deployments", json=deployment_payload)
    assert response.status_code == 201


# --- editing ----------------------------------------------------------------


def test_editing_a_deployment_updates_it_in_place(client, model_id, deployment_payload):
    """Deployments are mutable by design: changing a parameter must not force a
    new entity, or comparisons drown in near-duplicates."""
    created = client.post(f"/api/models/{model_id}/deployments", json=deployment_payload).json()
    client.patch(f"/api/deployments/{created['id']}", json={"synthetic_input_limit": 131072})
    client.patch(f"/api/deployments/{created['id']}", json={"note": "bumped"})

    listed = client.get(f"/api/models/{model_id}/deployments").json()
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]
    assert listed[0]["synthetic_input_limit"] == 131072
    assert listed[0]["note"] == "bumped"


def test_a_partial_update_leaves_untouched_fields_alone(client, model_id, deployment_payload):
    created = client.post(f"/api/models/{model_id}/deployments", json=deployment_payload).json()
    client.patch(f"/api/deployments/{created['id']}", json={"note": "changed"})
    updated = client.get(f"/api/deployments/{created['id']}").json()
    assert updated["router_url"] == deployment_payload["router_url"]
    assert updated["note"] == "changed"


def test_a_nullable_field_can_be_cleared_with_an_explicit_null(client, model_id, deployment_payload):
    created = client.post(
        f"/api/models/{model_id}/deployments", json={**deployment_payload, "context_length": 32768}
    ).json()
    client.patch(f"/api/deployments/{created['id']}", json={"context_length": None})
    assert client.get(f"/api/deployments/{created['id']}").json()["context_length"] is None


def test_an_unknown_deployment_is_a_404(client):
    assert client.get("/api/deployments/999").status_code == 404
    assert client.patch("/api/deployments/999", json={"note": "x"}).status_code == 404


def test_target_url_cannot_change_while_a_cell_is_queued_or_running(client, deployment_id, cell_id):
    from server import store

    connection = store.connect(client.app.state.db_path)
    try:
        store.queue_cell(connection, cell_id)
    finally:
        connection.close()
    url = "http://different-host:9000"
    assert client.patch(f"/api/deployments/{deployment_id}", json={"router_url": url}).status_code == 409
    assert client.patch(f"/api/deployments/{deployment_id}", json={"note": "still editable"}).status_code == 200

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "running")
    finally:
        connection.close()
    assert client.patch(f"/api/deployments/{deployment_id}", json={"router_url": url}).status_code == 409

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "completed")
    finally:
        connection.close()
    assert client.patch(f"/api/deployments/{deployment_id}", json={"router_url": url}).status_code == 200


# --- router url normalisation ----------------------------------------------


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("http://172.18.16.149:9000", "http://172.18.16.149:9000"),
        ("http://172.18.16.149:9000/", "http://172.18.16.149:9000"),
        ("http://172.18.16.149:9000/v1", "http://172.18.16.149:9000"),
        ("http://172.18.16.149:9000/v1/", "http://172.18.16.149:9000"),
        ("172.18.16.149:9000", "http://172.18.16.149:9000"),
        ("  http://host:9000  ", "http://host:9000"),
        ("https://host.example.com/", "https://host.example.com"),
    ],
)
def test_router_urls_are_stored_in_one_canonical_form(client, model_id, deployment_payload, given, expected):
    """A trailing /v1 is dropped because callers append their own path; keeping
    it would send requests to /v1/v1/completions."""
    created = client.post(
        f"/api/models/{model_id}/deployments", json={**deployment_payload, "router_url": given}
    ).json()
    assert created["router_url"] == expected


def test_a_deployment_registers_only_the_router(client, model_id, deployment_payload):
    """Not even a PD-disaggregated service lists its prefill and decode workers:
    the router is the only address this tool knows or needs."""
    created = client.post(f"/api/models/{model_id}/deployments", json=deployment_payload).json()
    assert "prefill_url" not in created
    assert "decode_url" not in created


# --- credentials ------------------------------------------------------------


@pytest.mark.parametrize(
    "resembles_a_key",
    ["sk-live-abc123", "sk.abc123", "1234ABC", "my key", "abc-123", "Bearer xyz", ""],
)
def test_api_key_env_refuses_anything_a_key_could_look_like(client, model_id, deployment_payload, resembles_a_key):
    """The field sits next to a URL and a model name, and pasting the key itself
    into it is exactly what someone in a hurry would do."""
    response = client.post(
        f"/api/models/{model_id}/deployments",
        json={**deployment_payload, "api_key_env": resembles_a_key},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("name", ["LLM_API_KEY", "OPENAI_API_KEY", "_PRIVATE", "A", "API_KEY_2"])
def test_api_key_env_accepts_a_real_environment_variable_name(client, model_id, deployment_payload, name):
    response = client.post(
        f"/api/models/{model_id}/deployments", json={**deployment_payload, "api_key_env": name}
    )
    assert response.status_code == 201


def test_a_key_sent_in_the_request_body_is_neither_stored_nor_echoed(client, model_id, deployment_payload):
    """There is no field for a key, so an extra one is ignored rather than kept."""
    secret = "sk-live-9f3ac21b7de4"
    response = client.post(
        f"/api/models/{model_id}/deployments",
        json={**deployment_payload, "api_key": secret, "key": secret, "token": secret},
    )
    assert response.status_code == 201
    assert secret not in response.text

    deployment_id = response.json()["id"]
    fetched = client.get(f"/api/deployments/{deployment_id}")
    assert secret not in json.dumps(fetched.json())
    assert secret not in client.get(f"/api/models/{model_id}/deployments").text


def test_the_key_never_reaches_the_database_file(client, model_id, deployment_payload):
    """The strongest form of the promise: not "we don't return it", but "it is
    not on disk". Checks the WAL too, since a committed row may still live there."""
    secret = "sk-live-9f3ac21b7de4"
    client.post(
        f"/api/models/{model_id}/deployments",
        json={**deployment_payload, "api_key": secret},
    )
    db_path = client.app.state.db_path
    for path in db_path.parent.glob(f"{db_path.name}*"):
        assert secret.encode() not in path.read_bytes(), f"{path.name} contains the key"


# --- defaults ---------------------------------------------------------------


def test_a_deployment_needs_only_its_identity(client, model_id):
    """Everything but name, router and model name has a usable default — the
    create form should not be a wall of fields."""
    response = client.post(
        f"/api/models/{model_id}/deployments",
        json={"name": "minimal", "router_url": "http://host:9000", "model_name": "m"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["api_key_env"] == "LLM_API_KEY"
    assert body["synthetic_input_limit"] > 0
    assert body["context_length"] is None


def test_a_blank_model_name_is_refused(client, model_id, deployment_payload):
    response = client.post(
        f"/api/models/{model_id}/deployments", json={**deployment_payload, "model_name": "  "}
    )
    assert response.status_code == 422


def test_a_non_positive_synthetic_input_limit_is_refused(client, model_id, deployment_payload):
    response = client.post(
        f"/api/models/{model_id}/deployments", json={**deployment_payload, "synthetic_input_limit": 0}
    )
    assert response.status_code == 422


def test_deployments_list_oldest_first(client, model_id, deployment_payload):
    client.post(f"/api/models/{model_id}/deployments", json={**deployment_payload, "name": "older"})
    client.post(f"/api/models/{model_id}/deployments", json={**deployment_payload, "name": "newer"})
    body = client.get(f"/api/models/{model_id}/deployments").json()
    assert [d["name"] for d in body] == ["older", "newer"]


def test_omitted_fields_fall_back_to_built_in_defaults(client, model_id):
    """Two layers only: what the caller supplied, then the built-in default."""
    created = client.post(
        f"/api/models/{model_id}/deployments",
        json={"name": "d", "router_url": "http://host:9000", "model_name": "m"},
    ).json()
    assert created["api_key_env"] == "LLM_API_KEY"
    assert created["synthetic_input_limit"] == 65536


def test_models_no_longer_accept_defaults(client, model_id):
    """The feature is gone: the key is ignored, and no model carries one."""
    client.patch(f"/api/models/{model_id}", json={"defaults": {"topology": "2P1D"}})
    assert "defaults" not in client.get(f"/api/models/{model_id}").json()


def test_deleting_a_deployment_cascades_to_its_cells(client, deployment_id, cell_id):
    assert client.delete(f"/api/deployments/{deployment_id}").status_code == 204
    assert client.get(f"/api/deployments/{deployment_id}").status_code == 404
    assert client.get(f"/api/cells/{cell_id}").status_code == 404


def test_a_deployment_with_a_cell_in_flight_refuses_to_delete(client, deployment_id, cell_id):
    from server import store

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "running")
    finally:
        connection.close()

    response = client.delete(f"/api/deployments/{deployment_id}")
    assert response.status_code == 409
    assert client.get(f"/api/deployments/{deployment_id}").status_code == 200
