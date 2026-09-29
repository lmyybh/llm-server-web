import pytest
import asyncio

from llmbench import inspection

from server import store


def create_service(client, name):
    response = client.post("/api/services", json={
        "name": name, "router_url": "http://host:9000", "api_key_env": "LLM_API_KEY",
    })
    assert response.status_code == 201
    return response.json()


def test_settings_persist_and_only_new_services_receive_defaults(client):
    old = create_service(client, "existing")
    response = client.patch("/api/inspection-cases/health.generate", json={
        "title": "  健康入口  ", "timeout_seconds": 75, "default_enabled": False,
    })
    assert response.status_code == 200
    changed = client.get("/api/inspection-cases").json()[0]
    assert changed["title"] == "健康入口"
    assert changed["timeout_seconds"] == 75
    assert changed["steps"] and changed["pass_rule"]
    assert "health.generate" in client.get(f"/api/services/{old['id']}").json()["enabled_case_ids"]
    new = create_service(client, "new")
    assert "health.generate" not in new["enabled_case_ids"]
    reset = client.post("/api/inspection-cases/reset")
    assert reset.status_code == 200
    assert reset.json()[0]["title"] == "生成接口健康检查"
    assert reset.json()[0]["timeout_seconds"] == 60
    assert "health.generate" not in client.get(f"/api/services/{new['id']}").json()["enabled_case_ids"]


def test_run_keeps_its_timeout_and_title_snapshot(client):
    service = create_service(client, "snapshot")
    client.patch("/api/inspection-cases/health.generate", json={"timeout_seconds": 75})
    run = client.post(f"/api/services/{service['id']}/inspections").json()
    assert run["case_settings"][0]["timeout_seconds"] == 75
    client.patch("/api/inspection-cases/health.generate", json={"timeout_seconds": 120})
    assert client.get(f"/api/inspections/{run['id']}").json()["case_settings"][0]["timeout_seconds"] == 75


@pytest.mark.parametrize("changes", [
    {"title": "   "}, {"title": None}, {"timeout_seconds": 0},
    {"timeout_seconds": 901}, {"timeout_seconds": 1.5},
    {"timeout_seconds": None}, {"default_enabled": None},
])
def test_invalid_settings_are_rejected(client, changes):
    assert client.patch("/api/inspection-cases/health.generate", json=changes).status_code == 422
    assert client.get("/api/inspection-cases").json()[0]["timeout_seconds"] == 60


def test_unknown_case_is_not_created(client):
    assert client.patch("/api/inspection-cases/no-such-case", json={"title": "X"}).status_code == 404


def test_custom_group_persists_and_can_be_reused(client):
    response = client.patch("/api/inspection-cases/health.generate", json={"group": "  专项检查  "})
    assert response.status_code == 200
    assert response.json()["group"] == "专项检查"
    assert client.get("/api/inspection-cases").json()[0]["group"] == "专项检查"
    client.patch("/api/inspection-cases/completion.non_stream", json={"group": "专项检查"})
    client.patch("/api/inspection-cases/health.generate", json={"timeout_seconds": 75})
    cases = client.get("/api/inspection-cases").json()
    assert [c["group"] for c in cases[:2]] == ["专项检查", "专项检查"]
    assert cases[0]["timeout_seconds"] == 75
    assert client.post("/api/inspection-cases/reset").json()[0]["group"] == "基础接口"


@pytest.mark.parametrize("group", ["", "  ", None, "字" * 31])
def test_invalid_group_is_rejected(client, group):
    assert client.patch("/api/inspection-cases/health.generate", json={"group": group}).status_code == 422


def test_v13_settings_migrate_without_losing_custom_values(tmp_path):
    import sqlite3
    path = tmp_path / "v13.db"
    connection = sqlite3.connect(path)
    connection.execute("""CREATE TABLE inspection_case_setting (
        case_id TEXT PRIMARY KEY, title TEXT NOT NULL, timeout_seconds INTEGER NOT NULL,
        default_enabled INTEGER NOT NULL)""")
    connection.execute("INSERT INTO inspection_case_setting VALUES ('health.generate', '旧名称', 75, 0)")
    connection.execute("PRAGMA user_version = 13")
    connection.commit()
    connection.close()
    connection = store.connect(path)
    case = store.list_inspection_cases(connection)[0]
    assert (case["title"], case["timeout_seconds"], case["default_enabled"], case["group"]) == (
        "旧名称", 75, False, "基础接口",
    )
    store.update_inspection_case(connection, "health.generate", {"group": "新标签"})
    assert store.list_inspection_cases(connection)[0]["group"] == "新标签"
    connection.close()


def test_empty_defaults_require_selection_before_execution(client):
    for case in client.get("/api/inspection-cases").json():
        client.patch(f"/api/inspection-cases/{case['case_id']}", json={"default_enabled": False})
    service = create_service(client, "manual")
    assert service["enabled_case_ids"] == []
    assert client.post(f"/api/services/{service['id']}/inspections").status_code == 422


def test_legacy_service_defaults_stay_unchanged(tmp_path):
    connection = store.connect(tmp_path / "legacy.db")
    service = store.create_service(connection, {
        "name": "legacy", "note": "", "router_url": "http://host:9000", "api_key_env": "KEY",
    })
    connection.execute("UPDATE service SET enabled_case_ids_json = NULL")
    store.update_inspection_case(connection, "health.generate", {"default_enabled": False})
    assert "health.generate" in store.get_service(connection, service["id"])["enabled_case_ids"]
    connection.close()


def test_executor_uses_configured_deadline(monkeypatch):
    async def discover(*args, **kwargs):
        return inspection.TargetFacts("http://test", "model"), []

    async def slow_probe(*args, **kwargs):
        await asyncio.sleep(0.1)
        return inspection.CaseOutcome("health.generate", True, inspection.PASS, "ok")

    monkeypatch.setattr(inspection, "discover", discover)
    monkeypatch.setattr(inspection, "catalogue", lambda: [
        inspection.Case("health.generate", slow_probe, timeout_seconds=60),
    ])
    result = asyncio.run(inspection.run_inspection(
        "http://test", case_timeouts={"health.generate": 0.01},
    ))
    assert result.cases[0].reason_code == "case_deadline"


def test_runner_receives_snapshot_not_current_settings(tmp_path, monkeypatch):
    from server import inspection_runner
    path = tmp_path / "runner.db"
    connection = store.connect(path)
    service = store.create_service(connection, {
        "name": "runner", "note": "", "router_url": "http://test", "api_key_env": "KEY",
    })
    store.update_inspection_case(connection, "health.generate", {"timeout_seconds": 75})
    run = store.create_inspection_run(connection, service["id"])
    store.update_inspection_case(connection, "health.generate", {"timeout_seconds": 120})
    connection.close()
    captured = {}

    async def inspect(*args, **kwargs):
        captured.update(kwargs)
        return inspection.RunSummary(inspection.SUITE_VERSION, inspection.TargetFacts("http://test", "m"))

    monkeypatch.setattr(inspection_runner, "run_inspection", inspect)
    asyncio.run(inspection_runner.execute(run["id"], path))
    assert captured["case_timeouts"]["health.generate"] == 75
