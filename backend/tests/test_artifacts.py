"""What a Cell leaves on disk.

The aggregates in the database can only be regretted when a definition turns
out to be wrong. These files are what make it recomputable — so they have to
contain the per-request evidence, and they have to contain no credentials.
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO

from llmbench.loadgen import LevelResult, RequestObservation
from server import store
from server.runner import _write_level, _write_manifest, _write_plan

CELL = {"id": 7, "mode": "concurrency", "level": 8.0, "num_requests": 4}
DEPLOYMENT = {
    "id": 1,
    "name": "2P1D-tp8",
    "router_url": "http://host:9000",
    "model_name": "m",
    "api_key_env": "PRIVATE_KEY_VAR",
}
WORKLOAD = {
    "id": 1,
    "name": "prefill-1k-128",
    "kind": "synthetic",
    "input_tokens": 1024,
    "output_tokens": 128,
    "dataset": None,
}
SNAPSHOT = {
    "workload": WORKLOAD,
    "mode": "concurrency",
    "level": 8.0,
    "num_requests": 4,
    "warmup_requests": 5,
    "flush_cache": True,
    "seed": 42,
    "executor": "testhost",
    "tool": "llmbench 0.1.0",
}


def a_level(n: int = 3) -> LevelResult:
    observations = [
        RequestObservation(
            success=True,
            e2e_ms=1000.0 + index,
            ttft_ms=200.0 + index,
            tpot_ms=13.0,
            prompt_tokens=1024,
            completion_tokens=128,
            cached_tokens=0,
            finish_reason="length",
        )
        for index in range(n)
    ]
    return LevelResult(
        concurrency=4,
        total_requests=n,
        successful_requests=n,
        failed_requests=0,
        duration_seconds=10.0,
        observations=observations,
    )


# --- what gets written ------------------------------------------------------


def test_the_plan_is_written_before_anything_is_measured(tmp_path):
    _write_plan(tmp_path, CELL, DEPLOYMENT, SNAPSHOT)
    plan = json.loads((tmp_path / "plan.json").read_text())

    assert plan["cell_id"] == 7
    assert plan["deployment"]["router_url"] == "http://host:9000"
    assert plan["snapshot"]["workload"]["name"] == "prefill-1k-128"
    assert plan["snapshot"]["flush_cache"] is True


def test_every_request_of_a_cell_is_written(tmp_path):
    _write_level(tmp_path, a_level(3))
    lines = (tmp_path / "level.jsonl").read_text().strip().splitlines()

    assert len(lines) == 3
    first = json.loads(lines[0])
    assert first["ttft_ms"] == 200.0
    assert first["e2e_ms"] == 1000.0
    assert first["completion_tokens"] == 128
    assert first["success"] is True


def test_the_per_request_evidence_is_enough_to_recompute_percentiles(tmp_path):
    """Which is the whole reason this file exists rather than only aggregates."""
    _write_level(tmp_path, a_level(5))
    values = [
        json.loads(line)["ttft_ms"]
        for line in (tmp_path / "level.jsonl").read_text().strip().splitlines()
    ]
    assert sorted(values) == [200.0, 201.0, 202.0, 203.0, 204.0]


def test_the_manifest_records_the_outcome(tmp_path):
    _write_manifest(tmp_path, CELL, SNAPSHOT, a_level(3))
    manifest = json.loads((tmp_path / "manifest.json").read_text())

    assert manifest["cell_id"] == 7
    assert manifest["result"]["successful_requests"] == 3
    assert manifest["snapshot"]["tool"] == "llmbench 0.1.0"


def test_the_manifest_records_a_failure(tmp_path):
    """A failed Cell still leaves a manifest: the attempt and how it ended."""
    _write_manifest(tmp_path, CELL, SNAPSHOT, None, error="connection refused")
    manifest = json.loads((tmp_path / "manifest.json").read_text())

    assert manifest["cell_id"] == 7
    assert manifest["result"]["error"] == "connection refused"


def test_the_artifacts_carry_a_variable_name_and_never_a_key(tmp_path):
    """The discipline is structural: nothing in the artifacts may be the key
    itself, only the NAME of the environment variable it comes from."""
    _write_plan(tmp_path, CELL, DEPLOYMENT, SNAPSHOT)
    _write_level(tmp_path, a_level(2))
    _write_manifest(tmp_path, CELL, SNAPSHOT, a_level(2))

    blob = b"".join(path.read_bytes() for path in tmp_path.glob("*"))
    assert b"PRIVATE_KEY_VAR" in blob
    assert b"sk-" not in blob


def test_a_rerun_overwrites_the_previous_evidence(tmp_path):
    """No history: a second measurement replaces the first one's files."""
    _write_level(tmp_path, a_level(3))
    _write_manifest(tmp_path, CELL, SNAPSHOT, a_level(3))

    from server.runner import _prepare_directory

    cell = {"id": 7, "artifact_dir": str(tmp_path)}
    _prepare_directory(cell)

    assert not (tmp_path / "level.jsonl").exists()
    assert not (tmp_path / "manifest.json").exists()


# --- over the API -------------------------------------------------------------


def test_a_cell_with_nothing_on_disk_lists_empty(client, cell_id):
    body = client.get(f"/api/cells/{cell_id}/artifacts").json()
    assert body["files"] == []


def test_an_unknown_cell_is_a_404(client):
    assert client.get("/api/cells/999/artifacts").status_code == 404


def test_a_recorded_path_outside_the_artifacts_root_is_refused(client, cell_id, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "plan.json").write_text("{}")

    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "running", artifact_dir=str(outside))
    finally:
        connection.close()

    response = client.get(f"/api/cells/{cell_id}/artifacts.zip")
    assert response.status_code == 500


def test_artifacts_download_as_one_zip(client, cell_id, tmp_path, monkeypatch):
    monkeypatch.setattr("server.app.ARTIFACTS_ROOT", tmp_path)
    directory = tmp_path / "cells" / str(cell_id)
    directory.mkdir(parents=True)
    (directory / "plan.json").write_text("{}")
    connection = store.connect(client.app.state.db_path)
    try:
        store.set_cell_status(connection, cell_id, "running", artifact_dir=str(directory))
    finally:
        connection.close()

    listing = client.get(f"/api/cells/{cell_id}/artifacts").json()
    assert [entry["name"] for entry in listing["files"]] == ["plan.json"]

    download = client.get(f"/api/cells/{cell_id}/artifacts.zip")
    assert download.status_code == 200
    with zipfile.ZipFile(BytesIO(download.content)) as archive:
        assert archive.namelist() == ["plan.json"]
