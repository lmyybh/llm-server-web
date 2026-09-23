"""Comparing Deployments of one Model over the HTTP API.

Pairing is a judgement, not a human choice: same workload identity, same
mode, same level. The ladders need not match — the axis is the union, and a
missing point says 未测 rather than silently vanishing.
"""

from __future__ import annotations

import pytest

from server import store

RESULT = {
    "total_requests": 64,
    "successful_requests": 64,
    "failed_requests": 0,
    "duration_seconds": 19.6,
    "achieved_qps": 3.27,
    "input_token_throughput": 3343.5,
    "output_token_throughput": 417.9,
    "ttft_p50": 788.7,
    "ttft_p95": 801.2,
    "ttft_p99": 805.9,
    "tpot_p50": 13.07,
    "tpot_p95": 13.38,
    "tpot_p99": 13.4,
    "e2e_p50": 2446.8,
    "e2e_p95": 2487.3,
    "e2e_p99": 2487.9,
}


@pytest.fixture
def deployment_ids(client, model_id, deployment_payload):
    ids = []
    for name in ("2P1D-tp8", "3P2D-tp4"):
        ids.append(
            client.post(
                f"/api/models/{model_id}/deployments",
                json={**deployment_payload, "name": name},
            ).json()["id"]
        )
    return ids


def seed(
    client,
    deployment_id: int,
    *,
    workload_name: str = "prefill-4k-128",
    mode: str = "concurrency",
    levels: list[float] = (4,),
    ttft_p99: float = 805.9,
    tool: str = "llmbench 0.1.0",
) -> None:
    """Completed Cells with canned results, written the way the executor would."""
    connection = store.connect(client.app.state.db_path)
    try:
        workload = next(
            (w for w in store.list_workloads(connection) if w["name"] == workload_name),
            None,
        )
        if workload is None:
            workload = store.create_workload(
                connection,
                {
                    "name": workload_name,
                    "kind": "synthetic",
                    "input_tokens": 4096,
                    "output_tokens": 128,
                },
            )
        cells = store.create_cells(
            connection,
            deployment_id,
            workload_id=workload["id"],
            mode=mode,
            levels=list(levels),
            num_requests=[64],
        )
        for cell in cells:
            store.record_cell_result(
                connection,
                cell["id"],
                {
                    **RESULT,
                    "ttft_p99": ttft_p99,
                    "executed_snapshot_json": {
                        "num_requests": 64,
                        "mode": mode,
                        "level": cell["level"],
                        "tool": tool,
                    },
                },
            )
            store.set_cell_status(connection, cell["id"], "completed")
    finally:
        connection.close()


def compare(client, model_id: int, ids: list[int]):
    return client.get(
        "/api/compare",
        params={"model_id": model_id, "deployment_ids": ",".join(str(i) for i in ids)},
    )


def test_matching_cells_align_on_a_shared_axis(client, model_id, deployment_ids):
    seed(client, deployment_ids[0], levels=[4, 16])
    seed(client, deployment_ids[1], levels=[4, 16], ttft_p99=900.0)

    body = compare(client, model_id, deployment_ids).json()
    assert len(body["sections"]) == 1
    section = body["sections"][0]
    assert section["workload"]["name"] == "prefill-4k-128"
    assert section["mode"] == "concurrency"
    assert section["levels"] == [4.0, 16.0]
    assert section["no_common_levels"] is False

    row = section["rows"][0]
    first, second = (row["cells"][str(deployment_ids[0])], row["cells"][str(deployment_ids[1])])
    assert first["ttft_p99"] == 805.9
    assert second["ttft_p99"] == 900.0
    assert first["last_run_at"] is not None


def test_partially_overlapping_ladders_still_compare(client, model_id, deployment_ids):
    """The reason Cells replaced sweeps: A ran [1,4], B ran [4,16] — the
    shared point is still a comparison, and the missing ones say so."""
    seed(client, deployment_ids[0], levels=[1, 4])
    seed(client, deployment_ids[1], levels=[4, 16])

    section = compare(client, model_id, deployment_ids).json()["sections"][0]
    assert section["levels"] == [1.0, 4.0, 16.0]
    assert section["no_common_levels"] is False
    by_level = {row["level"]: row["cells"] for row in section["rows"]}
    assert by_level[1.0][str(deployment_ids[1])] is None  # 未测
    assert by_level[16.0][str(deployment_ids[0])] is None
    assert by_level[4.0][str(deployment_ids[0])] is not None


def test_disjoint_ladders_are_flagged_not_compared(client, model_id, deployment_ids):
    seed(client, deployment_ids[0], levels=[1])
    seed(client, deployment_ids[1], levels=[64])

    section = compare(client, model_id, deployment_ids).json()["sections"][0]
    assert section["no_common_levels"] is True


def test_sections_distinguish_workloads_and_modes(client, model_id, deployment_ids):
    seed(client, deployment_ids[0], levels=[4])
    seed(client, deployment_ids[1], levels=[4])
    seed(client, deployment_ids[0], workload_name="decode-1k-512", levels=[8])
    seed(client, deployment_ids[1], workload_name="decode-1k-512", levels=[8])
    seed(client, deployment_ids[0], mode="qps", levels=[2.0])
    seed(client, deployment_ids[1], mode="qps", levels=[2.0])

    sections = compare(client, model_id, deployment_ids).json()["sections"]
    assert {(s["workload"]["name"], s["mode"]) for s in sections} == {
        ("prefill-4k-128", "concurrency"),
        ("decode-1k-512", "concurrency"),
        ("prefill-4k-128", "qps"),
    }


def test_unfinished_cells_do_not_participate(client, model_id, deployment_ids, workload_id):
    seed(client, deployment_ids[0], levels=[4])
    # deployment 1 has only an idle cell — nothing to compare yet.
    client.post(
        f"/api/deployments/{deployment_ids[1]}/cells",
        json={"workload_id": workload_id, "mode": "concurrency", "levels": [4]},
    )

    sections = compare(client, model_id, deployment_ids).json()["sections"]
    section = next(s for s in sections if s["workload"]["name"] == "prefill-4k-128")
    row = section["rows"][0]
    assert row["cells"][str(deployment_ids[1])] is None


def test_a_difference_in_tooling_is_a_notice_not_a_verdict(client, model_id, deployment_ids):
    """The ruler changed. Both numbers are still true, but a reader deserves
    to know before reading a difference into them."""
    seed(client, deployment_ids[0], levels=[4], tool="llmbench 0.1.0")
    seed(client, deployment_ids[1], levels=[4], tool="llmbench 0.2.0")

    section = compare(client, model_id, deployment_ids).json()["sections"][0]
    assert section["notices"]
    assert "0.1.0" in section["notices"][0]


def test_every_deployment_must_belong_to_the_model(
    client, model_id, deployment_ids, deployment_payload
):
    other_model = client.post("/api/models", json={"name": "OtherModel"}).json()
    outsider = client.post(
        f"/api/models/{other_model['id']}/deployments",
        json={**deployment_payload, "name": "outsider"},
    ).json()

    response = compare(client, model_id, [deployment_ids[0], outsider["id"]])
    assert response.status_code == 422
    assert "only meaningful within one model" in response.json()["detail"]


def test_two_deployments_are_the_minimum(client, model_id, deployment_ids):
    response = compare(client, model_id, [deployment_ids[0]])
    assert response.status_code == 422


def test_a_malformed_id_list_is_refused(client, model_id):
    response = client.get("/api/compare", params={"model_id": model_id, "deployment_ids": "a,b"})
    assert response.status_code == 422


def test_an_unknown_deployment_is_a_404(client, model_id, deployment_ids):
    response = compare(client, model_id, [deployment_ids[0], 999])
    assert response.status_code == 404


def test_nothing_measured_returns_empty_sections(client, model_id, deployment_ids):
    body = compare(client, model_id, deployment_ids).json()
    assert body["sections"] == []
    assert len(body["deployments"]) == 2
