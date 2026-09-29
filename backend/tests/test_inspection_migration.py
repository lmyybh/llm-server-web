"""Historical tool verdicts retain the finish-reason rule."""

import json

from server import store


def _tool_case(finish_reason: str, verdict: str) -> dict:
    response = {"choices": [{
        "finish_reason": finish_reason,
        "message": {"tool_calls": [{"function": {"name": "echo", "arguments": '{"value":"pong"}'}}]},
    }]}
    return {
        "case_id": "extensions.tools", "required": True, "verdict": verdict,
        "reason_code": "assertions_passed" if verdict == "PASS" else "assertion_failed",
        "message": "" if verdict == "PASS" else "no valid tool call came back",
        "evidence": [{"response_status": 200, "response_body": json.dumps(response)}],
    }


def _seed_run(db, service_id: int, finish_reason: str, verdict: str) -> int:
    run = store.create_inspection_run(db, service_id)
    store.record_inspection_case(db, run["id"], 0, _tool_case(finish_reason, verdict))
    store.set_inspection_status(db, run["id"], "completed", verdict=verdict)
    db.execute("UPDATE inspection_run SET suite_version = '3' WHERE id = ?", (run["id"],))
    return run["id"]


def test_prior_auto_repair_is_reverted_without_changing_genuine_passes(tmp_path):
    path = tmp_path / "inspections.db"
    db = store.connect(path)
    service = store.create_service(db, {
        "name": "service", "note": "", "router_url": "http://example.invalid", "api_key_env": "TEST_KEY",
    })
    repaired_id = _seed_run(db, service["id"], "length", "PASS")
    genuine_id = _seed_run(db, service["id"], "tool_calls", "PASS")
    db.execute("PRAGMA user_version = 10")
    db.close()

    db = store.connect(path)
    repaired = store.get_inspection_run(db, repaired_id)
    genuine = store.get_inspection_run(db, genuine_id)
    assert repaired["cases"][0]["verdict"] == "FAIL"
    assert repaired["verdict"] == "FAIL"
    assert "suite_version" not in repaired
    assert db.execute("SELECT suite_version FROM inspection_run WHERE id = ?", (repaired_id,)).fetchone()[0] == "3"
    assert genuine["cases"][0]["verdict"] == "PASS"
    assert genuine["verdict"] == "PASS"
    db.close()


def test_older_failures_are_not_auto_repaired(tmp_path):
    path = tmp_path / "inspections.db"
    db = store.connect(path)
    service = store.create_service(db, {
        "name": "service", "note": "", "router_url": "http://example.invalid", "api_key_env": "TEST_KEY",
    })
    run_id = _seed_run(db, service["id"], "length", "FAIL")
    db.execute("PRAGMA user_version = 9")
    db.close()

    db = store.connect(path)
    run = store.get_inspection_run(db, run_id)
    assert run["cases"][0]["verdict"] == "FAIL"
    assert run["verdict"] == "FAIL"
    db.close()
