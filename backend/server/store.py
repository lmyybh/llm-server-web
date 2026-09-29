"""SQLite persistence for Models, Deployments, Workloads and Cells.

WAL mode is not optional: the measurement executor runs as a separate process
and writes Cell results while this process writes Cell status. Ownership is
split so the two never touch the same column, but they do touch the same
database file.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from llmbench.inspection import SUITE_VERSION, catalogue, case_catalogue

SCHEMA_VERSION = 14

SCHEMA = """
CREATE TABLE IF NOT EXISTS inspection_case_setting (
    case_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    timeout_seconds INTEGER NOT NULL CHECK(timeout_seconds BETWEEN 1 AND 900),
    default_enabled INTEGER NOT NULL CHECK(default_enabled IN (0, 1)),
    group_name TEXT
);
CREATE TABLE IF NOT EXISTS inspection_run_setting (
    inspection_run_id INTEGER PRIMARY KEY REFERENCES inspection_run(id) ON DELETE CASCADE,
    cases_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id              INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    note                  TEXT NOT NULL DEFAULT '',
    router_url            TEXT NOT NULL,
    model_name            TEXT NOT NULL,
    api_key_env           TEXT NOT NULL,
    context_length        INTEGER,
    synthetic_input_limit INTEGER NOT NULL,
    gpu_model             TEXT NOT NULL DEFAULT '',
    gpu_count             INTEGER,
    topology              TEXT NOT NULL DEFAULT '',
    image                 TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    UNIQUE (model_id, name)
);

CREATE INDEX IF NOT EXISTS deployment_model_idx ON deployment (model_id);

-- The Workload library is global: a Workload is a preset load *shape* shared
-- by every Deployment. It carries no bench parameters — mode, level and
-- request count all live on the Cell.
CREATE TABLE IF NOT EXISTS workload (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    note          TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL,            -- synthetic | dataset
    input_tokens  INTEGER,                  -- synthetic only
    output_tokens INTEGER,                  -- synthetic only
    dataset       TEXT,                     -- dataset only
    created_at    TEXT NOT NULL
);

-- A Workload is *added* to a Deployment before any Cell exists: the
-- attachment is what shows the Workload as a card on the Deployment page.
-- Creating the first Cell attaches implicitly, so the card does not vanish
-- when its last Cell is deleted.
CREATE TABLE IF NOT EXISTS deployment_workload (
    deployment_id INTEGER NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
    workload_id   INTEGER NOT NULL REFERENCES workload(id),
    created_at    TEXT NOT NULL,
    PRIMARY KEY (deployment_id, workload_id)
);

-- A Cell is one measurement point: a (deployment, workload, mode, level)
-- combination. It stores only its LATEST result — re-running overwrites.
-- There is no run history, by design (ADR-0001).
CREATE TABLE IF NOT EXISTS cell (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id           INTEGER NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
    workload_id             INTEGER NOT NULL REFERENCES workload(id),
    mode                    TEXT NOT NULL,  -- concurrency | qps
    level                   REAL NOT NULL,
    num_requests            INTEGER NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'idle',
    -- executor-owned columns: written only by the subprocess
    progress_json           TEXT,
    executed_snapshot_json  TEXT,
    last_run_at             TEXT,
    total_requests          INTEGER,
    successful_requests     INTEGER,
    failed_requests         INTEGER,
    duration_seconds        REAL,
    offered_qps             REAL,
    achieved_qps            REAL,
    actual_concurrency      REAL,
    input_token_throughput  REAL,
    output_token_throughput REAL,
    metric_summaries_json   TEXT,
    ttft_p50                REAL,
    ttft_p95                REAL,
    ttft_p99                REAL,
    tpot_p50                REAL,
    tpot_p95                REAL,
    tpot_p99                REAL,
    e2e_p50                 REAL,
    e2e_p95                 REAL,
    e2e_p99                 REAL,
    ttft_histogram_json     TEXT,
    tpot_histogram_json     TEXT,
    e2e_histogram_json      TEXT,
    finish_reasons_json     TEXT,
    error_categories_json   TEXT,
    -- backend-owned columns
    artifact_dir            TEXT,
    pid                     INTEGER,
    queued_at               TEXT,
    started_at              TEXT,
    finished_at             TEXT,
    error                   TEXT,
    created_at              TEXT NOT NULL,
    UNIQUE (deployment_id, workload_id, mode, level)
);

CREATE INDEX IF NOT EXISTS cell_deployment_idx ON cell (deployment_id, id);
CREATE INDEX IF NOT EXISTS cell_workload_idx ON cell (workload_id);

-- A ticket is issued on every enqueue. Its sequence reflects enqueue order,
-- even when an older Cell is re-run or several Cells share a timestamp.
CREATE TABLE IF NOT EXISTS cell_queue (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    cell_id  INTEGER NOT NULL UNIQUE REFERENCES cell(id) ON DELETE CASCADE
);

-- Reusable Cell configurations. A combination does not own run results; an
-- import copies missing configurations into a Deployment.
CREATE TABLE IF NOT EXISTS bench_suite (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bench_suite_cell (
    suite_id     INTEGER NOT NULL REFERENCES bench_suite(id) ON DELETE CASCADE,
    workload_id  INTEGER NOT NULL REFERENCES workload(id),
    mode         TEXT NOT NULL,
    level        REAL NOT NULL,
    num_requests INTEGER NOT NULL,
    PRIMARY KEY (suite_id, workload_id, mode, level)
);

CREATE INDEX IF NOT EXISTS bench_suite_cell_workload_idx ON bench_suite_cell (workload_id);

-- Inspection is a separate system with its own entities. It shares no table
-- with bench: a Service is not a Deployment, and an Inspection Run is not a
-- Cell. Wiring them together would mean every change to one had to be checked
-- against the other, for no gain — they answer different questions on
-- different rhythms.

CREATE TABLE IF NOT EXISTS service (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    note         TEXT NOT NULL DEFAULT '',
    router_url   TEXT NOT NULL,
    api_key_env  TEXT NOT NULL,
    enabled_case_ids_json TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inspection_run (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id    INTEGER NOT NULL REFERENCES service(id) ON DELETE CASCADE,
    suite_version TEXT,
    case_ids_json TEXT,
    target_json   TEXT,
    status        TEXT NOT NULL,
    verdict       TEXT,
    current_case  TEXT,
    progress_json TEXT,
    queued_at     TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT,
    error         TEXT,
    pid           INTEGER
);

CREATE INDEX IF NOT EXISTS inspection_run_service_idx ON inspection_run (service_id, id DESC);

CREATE TABLE IF NOT EXISTS inspection_case_result (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    inspection_run_id INTEGER NOT NULL REFERENCES inspection_run(id) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    case_id           TEXT NOT NULL,
    required          INTEGER NOT NULL,
    verdict           TEXT NOT NULL,
    reason_code       TEXT NOT NULL,
    message           TEXT NOT NULL DEFAULT '',
    evidence_json     TEXT,
    UNIQUE (inspection_run_id, ordinal)
);
"""

CELL_STATUSES = ("idle", "queued", "running", "completed", "failed", "cancelled")

TERMINAL_STATUSES = ("completed", "failed", "cancelled")
"""Terminal for Cells and inspection runs alike — both lifecycles end here."""

RUNNABLE_CELL_STATUSES = ("idle", "completed", "failed", "cancelled")
"""A Cell may be (re)queued from any state that is not already in flight."""

CELL_STATUS_FIELDS = ("status", "queued_at", "started_at", "finished_at", "error", "artifact_dir", "pid")
"""Columns the **backend** owns on a cell."""

CELL_RESULT_FIELDS = (
    "progress_json",
    "executed_snapshot_json",
    "last_run_at",
    "total_requests",
    "successful_requests",
    "failed_requests",
    "duration_seconds",
    "offered_qps",
    "achieved_qps",
    "actual_concurrency",
    "input_token_throughput",
    "output_token_throughput",
    "metric_summaries_json",
    "ttft_p50",
    "ttft_p95",
    "ttft_p99",
    "tpot_p50",
    "tpot_p95",
    "tpot_p99",
    "e2e_p50",
    "e2e_p95",
    "e2e_p99",
    "ttft_histogram_json",
    "tpot_histogram_json",
    "e2e_histogram_json",
    "finish_reasons_json",
    "error_categories_json",
)
"""Columns the **executor subprocess** owns on a cell.

The two sets are disjoint on purpose. WAL lets both processes write the same
database file, but not the same column safely — splitting ownership means no
lock, no transaction spanning processes, and no lost update.
"""

DEPLOYMENT_FIELDS = (
    "name",
    "note",
    "router_url",
    "model_name",
    "api_key_env",
    "context_length",
    "synthetic_input_limit",
    "gpu_model",
    "gpu_count",
    "topology",
    "image",
)

WORKLOAD_KINDS = ("synthetic", "dataset")

CELL_MODES = ("concurrency", "qps")


class NotFound(Exception):
    """The requested row does not exist."""


class Conflict(Exception):
    """A uniqueness constraint would be violated, or the state forbids it."""


class Invalid(Exception):
    """The request is well-formed but breaks a domain rule (maps to 422)."""


def connect(path: Path) -> sqlite3.Connection:
    """Open the database, creating the file and schema if needed.

    ``check_same_thread=False`` is required, not a shortcut. FastAPI runs sync
    dependencies *and* sync route handlers in a threadpool, and it makes no
    promise that a request's setup, body and teardown land on the same worker —
    in practice they often do not. A connection created on one worker and
    closed on another raises ``ProgrammingError`` under uvicorn.

    It is safe here because a connection belongs to exactly one request and is
    never touched by two threads at once. Starlette's TestClient runs
    everything on a single thread, so it cannot catch a regression of this —
    see ``tests/test_server_integration.py``.
    """
    path = Path(path)
    if path.parent and str(path.parent) != "":
        path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    init_db(connection)
    return connection


def init_db(connection: sqlite3.Connection) -> None:
    current_version = connection.execute("PRAGMA user_version").fetchone()[0]
    if 0 < current_version < SCHEMA_VERSION:
        if current_version < 4:
            # v4 restructuring: the Workload library goes global and Cells replace
            # runs/measurements/level_results. The old bench tables are
            # incompatible and are dropped outright — this project keeps no bench
            # history by design (ADR-0001). Inspection tables survive.
            # "workload" is a *new* v4 table; dropping it here only matters for a
            # database that already reached v4 through a pre-release schema, and
            # keeps the upgrade idempotent for those.
            for table in ("level_result", "measurement", "run", "workload"):
                connection.execute(f"DROP TABLE IF EXISTS {table}")
        # v5: Model defaults are gone — a new Deployment prefills from the
        # previous one instead. Drop the column where an older schema has it.
        model_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(model)").fetchall()
        }
        if "defaults_json" in model_columns:
            connection.execute("ALTER TABLE model DROP COLUMN defaults_json")
    connection.executescript(SCHEMA)
    setting_columns = {row[1] for row in connection.execute("PRAGMA table_info(inspection_case_setting)")}
    if "group_name" not in setting_columns:
        connection.execute("ALTER TABLE inspection_case_setting ADD COLUMN group_name TEXT")
    # Existing v6 databases keep their Cell results; newly measured runs fill
    # these columns while older runs simply report them as unavailable.
    if 0 < current_version < 7:
        cell_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(cell)").fetchall()
        }
        for column, kind in (("actual_concurrency", "REAL"), ("metric_summaries_json", "TEXT")):
            if column not in cell_columns:
                connection.execute(f"ALTER TABLE cell ADD COLUMN {column} {kind}")
    if 0 < current_version < 9:
        for table, column in (
            ("service", "enabled_case_ids_json"),
            ("inspection_run", "case_ids_json"),
            ("inspection_case_result", "evidence_json"),
        ):
            existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            if column not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
    if 0 < current_version < 11:
        _revert_tool_call_repairs(connection)
    if 0 < current_version < 12:
        # Existing queued Cells are normally released during startup recovery.
        # Preserve their relative order if the database is opened directly.
        for row in connection.execute(
            "SELECT id FROM cell WHERE status = 'queued' ORDER BY queued_at, id"
        ):
            connection.execute(
                "INSERT OR IGNORE INTO cell_queue (cell_id) VALUES (?)", (row["id"],)
            )
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _revert_tool_call_repairs(connection: sqlite3.Connection) -> None:
    """Undo v10's promotion of legacy calls without a tool_calls finish reason."""
    candidates = connection.execute(
        """SELECT result.inspection_run_id, result.ordinal, result.evidence_json
             FROM inspection_case_result AS result
             JOIN inspection_run AS run ON run.id = result.inspection_run_id
            WHERE run.status = 'completed'
              AND run.suite_version = '3'
              AND result.case_id = 'extensions.tools'
              AND result.verdict = 'PASS'
              AND result.reason_code = 'assertions_passed'
              AND result.message = ''
              AND result.evidence_json IS NOT NULL"""
    ).fetchall()
    reverted_runs: set[int] = set()
    for candidate in candidates:
        try:
            evidence = json.loads(candidate["evidence_json"])
            if not isinstance(evidence, list) or len(evidence) != 1:
                continue
            response = evidence[0]
            body = json.loads(response["response_body"])
            choices = body["choices"]
            if response["response_status"] != 200 or not isinstance(choices, list) or not choices:
                continue
            first = choices[0]
            if not isinstance(first, dict) or first.get("finish_reason") == "tool_calls":
                continue
        except (TypeError, ValueError, KeyError, IndexError):
            continue
        connection.execute(
            """UPDATE inspection_case_result
                  SET verdict = 'FAIL', reason_code = 'assertion_failed',
                      message = 'no valid tool call came back'
                WHERE inspection_run_id = ? AND ordinal = ?""",
            (candidate["inspection_run_id"], candidate["ordinal"]),
        )
        reverted_runs.add(candidate["inspection_run_id"])

    for run_id in reverted_runs:
        rows = connection.execute(
            "SELECT case_id, required, verdict, reason_code FROM inspection_case_result WHERE inspection_run_id = ?",
            (run_id,),
        ).fetchall()
        # This repair belongs to the legacy suite; do not apply suite 8 semantics
        # retroactively to historical results.
        required = [row["verdict"] for row in rows if row["required"]]
        verdict = (
            "FAIL" if any(value in ("FAIL", "ERROR") for value in required)
            else "INCONCLUSIVE" if "INCONCLUSIVE" in required else "PASS"
        )
        connection.execute("UPDATE inspection_run SET verdict = ? WHERE id = ?", (verdict, run_id))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


# --- models ----------------------------------------------------------------


def list_models(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        """
        SELECT m.*,
               (SELECT COUNT(*) FROM deployment d WHERE d.model_id = m.id) AS deployment_count,
               (SELECT MAX(c.last_run_at)
                  FROM cell c JOIN deployment d ON d.id = c.deployment_id
                 WHERE d.model_id = m.id) AS latest_run_at,
               (SELECT COUNT(*)
                  FROM cell c JOIN deployment d ON d.id = c.deployment_id
                 WHERE d.model_id = m.id AND c.status IN ('queued', 'running')) AS active_cells
        FROM model m
        ORDER BY m.created_at, m.id
        """
    ).fetchall()
    return [_model(dict(row)) for row in rows]


def get_model(connection: sqlite3.Connection, model_id: int) -> dict:
    row = connection.execute("SELECT * FROM model WHERE id = ?", (model_id,)).fetchone()
    if row is None:
        raise NotFound(f"model {model_id} does not exist")
    return _model(dict(row))


def _model(row: dict) -> dict:
    # Older databases still carry the column; it is dead weight now.
    row.pop("defaults_json", None)
    return row


def create_model(connection: sqlite3.Connection, name: str, note: str) -> dict:
    now = _now()
    try:
        cursor = connection.execute(
            "INSERT INTO model (name, note, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, note, now, now),
        )
    except sqlite3.IntegrityError as exc:
        raise Conflict(f"a model named {name!r} already exists") from exc
    return get_model(connection, int(cursor.lastrowid))


def update_model(connection: sqlite3.Connection, model_id: int, changes: dict) -> dict:
    get_model(connection, model_id)
    allowed = {key: value for key, value in changes.items() if key in ("name", "note")}
    if allowed:
        assignments = ", ".join(f"{key} = ?" for key in allowed)
        try:
            connection.execute(
                f"UPDATE model SET {assignments}, updated_at = ? WHERE id = ?",
                (*allowed.values(), _now(), model_id),
            )
        except sqlite3.IntegrityError as exc:
            raise Conflict(f"a model named {allowed.get('name')!r} already exists") from exc
    return get_model(connection, model_id)


# --- deployments -----------------------------------------------------------


def list_deployments(connection: sqlite3.Connection, model_id: int) -> list[dict]:
    get_model(connection, model_id)
    rows = connection.execute(
        "SELECT * FROM deployment WHERE model_id = ? ORDER BY created_at, id",
        (model_id,),
    ).fetchall()
    return [_with_cell_summary(connection, dict(row)) for row in rows]


def _with_cell_summary(connection: sqlite3.Connection, deployment: dict) -> dict:
    """Attach a one-line summary of the Deployment's Cells.

    Without it the only way to know a Deployment has been measured is to open
    it — the list should say "3 cells, latest finished at …" on its own.
    """
    rows = connection.execute(
        """
        SELECT status, COUNT(*) AS count, MAX(last_run_at) AS latest
          FROM cell
         WHERE deployment_id = ?
         GROUP BY status
        """,
        (deployment["id"],),
    ).fetchall()
    summary: dict[str, object] = {"total": 0, "by_status": {}, "latest_run_at": None}
    for row in rows:
        summary["by_status"][row["status"]] = row["count"]
        summary["total"] += row["count"]
        if row["latest"] and (
            summary["latest_run_at"] is None or row["latest"] > summary["latest_run_at"]
        ):
            summary["latest_run_at"] = row["latest"]
    deployment["cells"] = summary
    return deployment


def get_deployment(connection: sqlite3.Connection, deployment_id: int) -> dict:
    row = connection.execute("SELECT * FROM deployment WHERE id = ?", (deployment_id,)).fetchone()
    if row is None:
        raise NotFound(f"deployment {deployment_id} does not exist")
    return dict(row)


def create_deployment(connection: sqlite3.Connection, model_id: int, fields: dict) -> dict:
    get_model(connection, model_id)
    now = _now()
    columns = ["model_id", *DEPLOYMENT_FIELDS, "created_at", "updated_at"]
    values = [model_id, *(fields[name] for name in DEPLOYMENT_FIELDS), now, now]
    placeholders = ", ".join("?" for _ in columns)
    try:
        cursor = connection.execute(
            f"INSERT INTO deployment ({', '.join(columns)}) VALUES ({placeholders})", values
        )
    except sqlite3.IntegrityError as exc:
        raise Conflict(
            f"this model already has a deployment named {fields.get('name')!r}"
        ) from exc
    return get_deployment(connection, int(cursor.lastrowid))


def update_deployment(connection: sqlite3.Connection, deployment_id: int, changes: dict) -> dict:
    """Apply a partial update in place. A Deployment is mutable by design —
    changing a parameter must not force a new entity, or comparisons drown in
    near-duplicates. Correctness comes from the Cell's executed snapshot."""
    allowed = {key: value for key, value in changes.items() if key in DEPLOYMENT_FIELDS}
    if not allowed:
        return get_deployment(connection, deployment_id)
    connection.execute("BEGIN IMMEDIATE")
    try:
        deployment = get_deployment(connection, deployment_id)
        if "router_url" in allowed and allowed["router_url"] != deployment["router_url"]:
            in_flight = connection.execute(
                """SELECT COUNT(*) FROM cell
                   WHERE deployment_id = ? AND status IN ('queued', 'running')""",
                (deployment_id,),
            ).fetchone()[0]
            if in_flight:
                raise Conflict(
                    f"deployment {deployment_id} has {in_flight} queued or running cell(s); "
                    "wait or cancel them before changing its URL"
                )
        assignments = ", ".join(f"{key} = ?" for key in allowed)
        try:
            connection.execute(
                f"UPDATE deployment SET {assignments}, updated_at = ? WHERE id = ?",
                (*allowed.values(), _now(), deployment_id),
            )
        except sqlite3.IntegrityError as exc:
            raise Conflict(
                f"this model already has a deployment named {allowed.get('name')!r}"
            ) from exc
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return get_deployment(connection, deployment_id)


# --- workloads (global library) --------------------------------------------


def list_workloads(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        """
        SELECT w.*,
               (SELECT COUNT(*) FROM cell c WHERE c.workload_id = w.id) AS cell_count,
               (SELECT COUNT(DISTINCT sc.suite_id) FROM bench_suite_cell sc
                 WHERE sc.workload_id = w.id) AS suite_count,
               (SELECT COUNT(*) FROM (
                   SELECT c.deployment_id FROM cell c WHERE c.workload_id = w.id
                   UNION
                   SELECT dw.deployment_id FROM deployment_workload dw
                    WHERE dw.workload_id = w.id
               )) AS deployment_count
          FROM workload w
         ORDER BY w.name
        """
    ).fetchall()
    return [dict(row) for row in rows]


def get_workload(connection: sqlite3.Connection, workload_id: int) -> dict:
    row = connection.execute("SELECT * FROM workload WHERE id = ?", (workload_id,)).fetchone()
    if row is None:
        raise NotFound(f"workload {workload_id} does not exist")
    return dict(row)


def create_workload(connection: sqlite3.Connection, fields: dict) -> dict:
    """A preset load shape in the global library.

    Exactly one of the two kinds: synthetic (input/output token counts) or a
    named dataset. The schema layer enforces the shape; here we persist it.
    """
    try:
        cursor = connection.execute(
            """
            INSERT INTO workload (name, note, kind, input_tokens, output_tokens, dataset, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fields["name"],
                fields.get("note", ""),
                fields["kind"],
                fields.get("input_tokens"),
                fields.get("output_tokens"),
                fields.get("dataset"),
                _now(),
            ),
        )
    except sqlite3.IntegrityError as exc:
        raise Conflict(f"a workload named {fields['name']!r} already exists") from exc
    return get_workload(connection, int(cursor.lastrowid))


def update_workload(connection: sqlite3.Connection, workload_id: int, changes: dict) -> dict:
    """Only name and note may change. The shape is frozen at creation: a
    Workload is a *category*, and a category whose contents drift makes every
    pairing that references it a lie."""
    get_workload(connection, workload_id)
    allowed = {key: value for key, value in changes.items() if key in ("name", "note")}
    if allowed:
        assignments = ", ".join(f"{key} = ?" for key in allowed)
        try:
            connection.execute(
                f"UPDATE workload SET {assignments} WHERE id = ?",
                (*allowed.values(), workload_id),
            )
        except sqlite3.IntegrityError as exc:
            raise Conflict(f"a workload named {allowed.get('name')!r} already exists") from exc
    return get_workload(connection, workload_id)


def delete_workload(connection: sqlite3.Connection, workload_id: int) -> None:
    get_workload(connection, workload_id)
    in_suites = connection.execute(
        "SELECT COUNT(*) FROM bench_suite_cell WHERE workload_id = ?", (workload_id,)
    ).fetchone()[0]
    if in_suites:
        raise Conflict(f"workload {workload_id} is used by {in_suites} combination cell(s)")
    referenced = connection.execute(
        "SELECT COUNT(*) AS count FROM cell WHERE workload_id = ?", (workload_id,)
    ).fetchone()["count"]
    if referenced:
        raise Conflict(
            f"workload {workload_id} is referenced by {referenced} cell(s); "
            "delete those cells first"
        )
    attached = connection.execute(
        "SELECT COUNT(*) AS count FROM deployment_workload WHERE workload_id = ?",
        (workload_id,),
    ).fetchone()["count"]
    if attached:
        raise Conflict(
            f"workload {workload_id} is added to {attached} deployment(s); "
            "remove it there first"
        )
    connection.execute("DELETE FROM workload WHERE id = ?", (workload_id,))


# --- reusable bench combinations --------------------------------------------


def _suite(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
    suite = dict(row)
    suite["cells"] = [dict(item) for item in connection.execute(
        """SELECT workload_id, mode, level, num_requests
             FROM bench_suite_cell WHERE suite_id = ?
             ORDER BY workload_id, mode, level""",
        (suite["id"],),
    ).fetchall()]
    return suite


def list_suites(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute("SELECT * FROM bench_suite ORDER BY name").fetchall()
    return [_suite(connection, row) for row in rows]


def get_suite(connection: sqlite3.Connection, suite_id: int) -> dict:
    row = connection.execute("SELECT * FROM bench_suite WHERE id = ?", (suite_id,)).fetchone()
    if row is None:
        raise NotFound(f"combination {suite_id} does not exist")
    return _suite(connection, row)


def _validate_suite_workloads(connection: sqlite3.Connection, cells: list[dict]) -> None:
    for workload_id in {cell["workload_id"] for cell in cells}:
        get_workload(connection, workload_id)


def _insert_suite_cells(connection: sqlite3.Connection, suite_id: int, cells: list[dict]) -> None:
    connection.executemany(
        """INSERT INTO bench_suite_cell
           (suite_id, workload_id, mode, level, num_requests) VALUES (?, ?, ?, ?, ?)""",
        [(suite_id, cell["workload_id"], cell["mode"], cell["level"], cell["num_requests"])
         for cell in cells],
    )


def create_suite(connection: sqlite3.Connection, fields: dict) -> dict:
    _validate_suite_workloads(connection, fields["cells"])
    connection.execute("BEGIN IMMEDIATE")
    try:
        now = _now()
        cursor = connection.execute(
            "INSERT INTO bench_suite (name, note, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (fields["name"], fields.get("note", ""), now, now),
        )
        suite_id = int(cursor.lastrowid)
        _insert_suite_cells(connection, suite_id, fields["cells"])
    except sqlite3.IntegrityError as exc:
        connection.rollback()
        raise Conflict(f"a combination named {fields['name']!r} already exists") from exc
    except Exception:
        connection.rollback()
        raise
    connection.commit()
    return get_suite(connection, suite_id)


def update_suite(connection: sqlite3.Connection, suite_id: int, fields: dict) -> dict:
    get_suite(connection, suite_id)
    _validate_suite_workloads(connection, fields["cells"])
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "UPDATE bench_suite SET name = ?, note = ?, updated_at = ? WHERE id = ?",
            (fields["name"], fields.get("note", ""), _now(), suite_id),
        )
        connection.execute("DELETE FROM bench_suite_cell WHERE suite_id = ?", (suite_id,))
        _insert_suite_cells(connection, suite_id, fields["cells"])
    except sqlite3.IntegrityError as exc:
        connection.rollback()
        raise Conflict(f"a combination named {fields['name']!r} already exists") from exc
    except Exception:
        connection.rollback()
        raise
    connection.commit()
    return get_suite(connection, suite_id)


def delete_suite(connection: sqlite3.Connection, suite_id: int) -> None:
    get_suite(connection, suite_id)
    connection.execute("DELETE FROM bench_suite WHERE id = ?", (suite_id,))


def import_suite(connection: sqlite3.Connection, deployment_id: int, suite_id: int) -> dict:
    deployment = get_deployment(connection, deployment_id)
    suite = get_suite(connection, suite_id)
    workloads = {cell["workload_id"]: get_workload(connection, cell["workload_id"])
                 for cell in suite["cells"]}
    for workload in workloads.values():
        if workload["kind"] == "synthetic":
            for field in ("input_tokens", "output_tokens"):
                if workload[field] > deployment["synthetic_input_limit"]:
                    raise Invalid(
                        f"workload {workload['name']} {field} exceeds this deployment's "
                        "synthetic_input_limit"
                    )

    connection.execute("BEGIN IMMEDIATE")
    try:
        existing = {
            (row["workload_id"], row["mode"], row["level"])
            for row in connection.execute(
                "SELECT workload_id, mode, level FROM cell WHERE deployment_id = ?",
                (deployment_id,),
            ).fetchall()
        }
        attached = 0
        for workload_id in workloads:
            cursor = connection.execute(
                """INSERT OR IGNORE INTO deployment_workload
                   (deployment_id, workload_id, created_at) VALUES (?, ?, ?)""",
                (deployment_id, workload_id, _now()),
            )
            attached += cursor.rowcount
        created = 0
        for cell in suite["cells"]:
            key = (cell["workload_id"], cell["mode"], cell["level"])
            if key in existing:
                continue
            connection.execute(
                """INSERT INTO cell
                   (deployment_id, workload_id, mode, level, num_requests, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (deployment_id, *key, cell["num_requests"], _now()),
            )
            created += 1
    except Exception:
        connection.rollback()
        raise
    connection.commit()
    return {
        "created_cells": created,
        "skipped_cells": len(suite["cells"]) - created,
        "attached_workloads": attached,
    }


# --- deployment ↔ workload attachments ---------------------------------------


def list_deployment_workloads(connection: sqlite3.Connection, deployment_id: int) -> list[dict]:
    """Every Workload added to a Deployment, whether or not it has Cells yet.
    ``added_at`` is the attachment's own timestamp — cards sort by when the
    Workload joined *this* Deployment, not by when it entered the library."""
    get_deployment(connection, deployment_id)
    rows = connection.execute(
        """
        SELECT w.*, dw.created_at AS added_at
          FROM workload w
          JOIN deployment_workload dw ON dw.workload_id = w.id
         WHERE dw.deployment_id = ?
         ORDER BY dw.created_at, dw.workload_id
        """,
        (deployment_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def attach_workload(connection: sqlite3.Connection, deployment_id: int, workload_id: int) -> dict:
    """Add a Workload to a Deployment without configuring any Cell yet."""
    get_deployment(connection, deployment_id)
    get_workload(connection, workload_id)
    try:
        connection.execute(
            """
            INSERT INTO deployment_workload (deployment_id, workload_id, created_at)
            VALUES (?, ?, ?)
            """,
            (deployment_id, workload_id, _now()),
        )
    except sqlite3.IntegrityError as exc:
        raise Conflict(
            f"workload {workload_id} is already added to deployment {deployment_id}"
        ) from exc
    return get_workload(connection, workload_id)


def detach_workload(connection: sqlite3.Connection, deployment_id: int, workload_id: int) -> None:
    """Remove a Workload from a Deployment. Blocked while Cells reference the
    pair: removing the attachment must not hide results from the page."""
    get_deployment(connection, deployment_id)
    get_workload(connection, workload_id)
    referenced = connection.execute(
        "SELECT COUNT(*) AS count FROM cell WHERE deployment_id = ? AND workload_id = ?",
        (deployment_id, workload_id),
    ).fetchone()["count"]
    if referenced:
        raise Conflict(
            f"workload {workload_id} still has {referenced} cell(s) under "
            f"deployment {deployment_id}; delete those cells first"
        )
    cursor = connection.execute(
        "DELETE FROM deployment_workload WHERE deployment_id = ? AND workload_id = ?",
        (deployment_id, workload_id),
    )
    if cursor.rowcount == 0:
        raise NotFound(f"workload {workload_id} is not added to deployment {deployment_id}")


def _ensure_attachment(connection: sqlite3.Connection, deployment_id: int, workload_id: int) -> None:
    """The first Cell under a (Deployment, Workload) attaches the pair, so the
    card survives deleting its last Cell."""
    connection.execute(
        """
        INSERT OR IGNORE INTO deployment_workload (deployment_id, workload_id, created_at)
        VALUES (?, ?, ?)
        """,
        (deployment_id, workload_id, _now()),
    )


# --- cells ------------------------------------------------------------------


_CELL_JSON_FIELDS = (
    ("progress_json", "progress"),
    ("executed_snapshot_json", "executed_snapshot"),
    ("metric_summaries_json", "metric_summaries"),
    ("ttft_histogram_json", "ttft_histogram"),
    ("tpot_histogram_json", "tpot_histogram"),
    ("e2e_histogram_json", "e2e_histogram"),
    ("finish_reasons_json", "finish_reasons"),
    ("error_categories_json", "error_categories"),
)


def _cell(row: dict) -> dict:
    for column, key in _CELL_JSON_FIELDS:
        raw = row.pop(column)
        row[key] = json.loads(raw) if raw else None
    row["stale"] = _is_stale(row)
    return row


def _is_stale(cell: dict) -> bool:
    """The displayed result came from a different configuration than the
    current one. A missing snapshot is itself a value: a Cell that has never
    run is not stale, it is empty — so absence means False here, and the
    result columns being NULL is what the page should read instead."""
    snapshot = cell.get("executed_snapshot")
    if not snapshot:
        return False
    return bool(
        snapshot.get("num_requests") != cell["num_requests"]
        or snapshot.get("mode") != cell["mode"]
        or snapshot.get("level") != cell["level"]
    )


def create_cells(
    connection: sqlite3.Connection,
    deployment_id: int,
    *,
    workload_id: int,
    mode: str,
    levels: list[float],
    num_requests: list[int],
) -> list[dict]:
    """Expand a level ladder into Cells under a Deployment, one request count
    per level (a single count broadcasts across the ladder).

    The batch is all-or-nothing — genuinely: the connection is in autocommit
    mode, so the conflict check and the inserts are wrapped in an explicit
    transaction. Without it a mid-batch failure would leave half a ladder
    behind, and two concurrent creators could both pass the check, the loser
    getting a bare IntegrityError instead of a conflict.
    """
    deployment = get_deployment(connection, deployment_id)
    workload = get_workload(connection, workload_id)
    if mode not in CELL_MODES:
        raise Invalid(f"mode must be one of {CELL_MODES}")
    if not levels:
        raise Invalid("at least one level is required")
    if len(num_requests) == 1:
        num_requests = num_requests * len(levels)
    if len(num_requests) != len(levels):
        raise Invalid(
            f"num_requests has {len(num_requests)} value(s) but the ladder has "
            f"{len(levels)} level(s); give one count to broadcast, or one per level"
        )

    if workload["kind"] == "synthetic":
        limit = deployment["synthetic_input_limit"]
        for field in ("input_tokens", "output_tokens"):
            if workload[field] > limit:
                raise Invalid(
                    f"workload {field} {workload[field]} exceeds this "
                    f"deployment's synthetic_input_limit {limit}; raise the limit or "
                    "pick a smaller workload"
                )

    # BEGIN IMMEDIATE takes the write lock *before* the check, so a concurrent
    # creator blocks instead of racing past it.
    connection.execute("BEGIN IMMEDIATE")
    try:
        conflicts = [
            row["level"]
            for row in connection.execute(
                f"""
                SELECT level FROM cell
                 WHERE deployment_id = ? AND workload_id = ? AND mode = ?
                   AND level IN ({", ".join("?" for _ in levels)})
                """,
                (deployment_id, workload_id, mode, *levels),
            ).fetchall()
        ]
        if conflicts:
            rendered = ", ".join(str(level) for level in sorted(conflicts))
            raise Conflict(f"these cells already exist for mode={mode}: level {rendered}")

        now = _now()
        _ensure_attachment(connection, deployment_id, workload_id)
        created = []
        for level, requests in zip(levels, num_requests):
            cursor = connection.execute(
                """
                INSERT INTO cell (deployment_id, workload_id, mode, level, num_requests, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (deployment_id, workload_id, mode, float(level), requests, now),
            )
            created.append(get_cell(connection, int(cursor.lastrowid)))
    except Exception:
        connection.rollback()
        raise
    connection.commit()
    return created


def list_cells(connection: sqlite3.Connection, deployment_id: int) -> list[dict]:
    get_deployment(connection, deployment_id)
    rows = connection.execute(
        """
        SELECT c.*, w.name AS workload_name, w.kind AS workload_kind,
               w.input_tokens AS workload_input_tokens,
               w.output_tokens AS workload_output_tokens,
               w.dataset AS workload_dataset
          FROM cell c
          JOIN workload w ON w.id = c.workload_id
         WHERE c.deployment_id = ?
         ORDER BY w.name, c.mode, c.level
        """,
        (deployment_id,),
    ).fetchall()
    return [_cell(dict(row)) for row in rows]


def get_cell(connection: sqlite3.Connection, cell_id: int) -> dict:
    row = connection.execute("SELECT * FROM cell WHERE id = ?", (cell_id,)).fetchone()
    if row is None:
        raise NotFound(f"cell {cell_id} does not exist")
    cell = _cell(dict(row))
    cell["workload"] = get_workload(connection, cell["workload_id"])
    return cell


def update_cell(connection: sqlite3.Connection, cell_id: int, changes: dict) -> dict:
    """Only ``num_requests`` is adjustable. Mode and level are identity — they
    are part of the uniqueness key, so changing them is delete-and-recreate,
    not an edit."""
    get_cell(connection, cell_id)
    allowed = {key: value for key, value in changes.items() if key == "num_requests"}
    if allowed:
        connection.execute(
            "UPDATE cell SET num_requests = ? WHERE id = ?",
            (allowed["num_requests"], cell_id),
        )
    return get_cell(connection, cell_id)


def delete_deployment(connection: sqlite3.Connection, deployment_id: int) -> None:
    """Remove a Deployment and, by cascade, every Cell under it.

    In-flight Cells refuse: deleting the row out from under a running
    executor would leave its result landing nowhere.
    """
    get_deployment(connection, deployment_id)
    in_flight = connection.execute(
        "SELECT COUNT(*) AS count FROM cell WHERE deployment_id = ? AND status IN ('queued', 'running')",
        (deployment_id,),
    ).fetchone()["count"]
    if in_flight:
        raise Conflict(
            f"deployment {deployment_id} has {in_flight} cell(s) queued or running; "
            "cancel them before deleting"
        )
    connection.execute("DELETE FROM deployment WHERE id = ?", (deployment_id,))


def delete_model(connection: sqlite3.Connection, model_id: int) -> None:
    """Remove a Model; its Deployments and their Cells follow by cascade.

    Same in-flight rule as deleting a Deployment, one level up.
    """
    get_model(connection, model_id)
    in_flight = connection.execute(
        """
        SELECT COUNT(*) AS count FROM cell c
        JOIN deployment d ON d.id = c.deployment_id
        WHERE d.model_id = ? AND c.status IN ('queued', 'running')
        """,
        (model_id,),
    ).fetchone()["count"]
    if in_flight:
        raise Conflict(
            f"model {model_id} has {in_flight} cell(s) queued or running; "
            "cancel them before deleting"
        )
    connection.execute("DELETE FROM model WHERE id = ?", (model_id,))


def delete_cell(connection: sqlite3.Connection, cell_id: int) -> None:
    cell = get_cell(connection, cell_id)
    if cell["status"] in ("queued", "running"):
        raise Conflict(f"cell {cell_id} is {cell['status']}; cancel it before deleting")
    connection.execute("DELETE FROM cell WHERE id = ?", (cell_id,))


def queue_cell(connection: sqlite3.Connection, cell_id: int) -> dict:
    """Mark a Cell queued. Re-queueing a completed Cell is how a re-run starts:
    the executor overwrites the result columns when it finishes. Progress from
    the previous run is cleared here, not by the executor, so the page never
    shows last time's final update as if it were this run's."""
    connection.execute("BEGIN IMMEDIATE")
    try:
        cell = get_cell(connection, cell_id)
        if cell["status"] not in RUNNABLE_CELL_STATUSES:
            raise Conflict(f"cell {cell_id} is {cell['status']}; it cannot be started now")
        connection.execute("INSERT INTO cell_queue (cell_id) VALUES (?)", (cell_id,))
        connection.execute(
            "UPDATE cell SET status = 'queued', queued_at = ?, pid = NULL, error = NULL, progress_json = NULL WHERE id = ?",
            (_now(), cell_id),
        )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return get_cell(connection, cell_id)


def next_queued_cell_id(connection: sqlite3.Connection) -> int | None:
    row = connection.execute(
        """SELECT c.id FROM cell_queue AS q
           JOIN cell AS c ON c.id = q.cell_id
           WHERE c.status = 'queued' ORDER BY q.position LIMIT 1"""
    ).fetchone()
    return row["id"] if row is not None else None


def startable_queued_cell_ids(
    connection: sqlite3.Connection, blocked_urls: set[str] | None = None
) -> list[int]:
    """Oldest queued Cell for each URL that has no running Cell."""
    busy_urls = set(blocked_urls or ())
    busy_urls.update(
        row["router_url"]
        for row in connection.execute(
            """SELECT DISTINCT d.router_url FROM cell AS c
               JOIN deployment AS d ON d.id = c.deployment_id
               WHERE c.status = 'running'"""
        )
    )
    busy_urls.update(active_inspection_urls(connection))
    startable = []
    for row in connection.execute(
        """SELECT c.id, d.router_url FROM cell_queue AS q
           JOIN cell AS c ON c.id = q.cell_id
           JOIN deployment AS d ON d.id = c.deployment_id
           WHERE c.status = 'queued' ORDER BY q.position"""
    ):
        if row["router_url"] not in busy_urls:
            startable.append(row["id"])
            busy_urls.add(row["router_url"])
    return startable


def set_cell_status(
    connection: sqlite3.Connection,
    cell_id: int,
    status: str,
    *,
    error: str | None = None,
    artifact_dir: str | None = None,
    pid: int | None = None,
    expected_pid: int | None = None,
) -> bool:
    """Backend-owned. The executor never calls this.

    Returns whether the write applied. A terminal status is written only to a
    Cell that is still open, so a cancel and a finishing executor cannot both
    win: whichever arrives second finds the status already terminal and its
    own write is dropped by the ``WHERE`` clause rather than racing in Python.
    """
    if status not in CELL_STATUSES:
        raise ValueError(f"unknown cell status {status!r}")
    now = _now()
    started_at = now if status == "running" else None
    finished_at = now if status in TERMINAL_STATUSES else None

    guard = ""
    if status in TERMINAL_STATUSES:
        guard = " AND status NOT IN ('completed', 'failed', 'cancelled')"
    if expected_pid is not None:
        guard += " AND status = 'running' AND pid = ?"

    connection.execute("BEGIN IMMEDIATE")
    try:
        cursor = connection.execute(
            f"""
            UPDATE cell
               SET status = ?,
                   error = ?,
                   artifact_dir = COALESCE(?, artifact_dir),
                   pid = COALESCE(?, pid),
                   started_at = COALESCE(?, started_at),
                   finished_at = COALESCE(?, finished_at)
             WHERE id = ?{guard}
            """,
            (status, error, artifact_dir, pid, started_at, finished_at, cell_id)
            + ((expected_pid,) if expected_pid is not None else ()),
        )
        if cursor.rowcount == 1:
            if status == "queued":
                connection.execute(
                    "INSERT OR IGNORE INTO cell_queue (cell_id) VALUES (?)", (cell_id,)
                )
            else:
                connection.execute("DELETE FROM cell_queue WHERE cell_id = ?", (cell_id,))
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return cursor.rowcount == 1


def cancel_cell(connection: sqlite3.Connection, cell_id: int) -> bool:
    """Stop a Cell. Returns False if it had already finished.

    Status is written **before** the signal, so the supervisor thread — which
    is about to see its child die — finds a terminal status and leaves it
    alone instead of filing the death as a failure.
    """
    return set_cell_status(connection, cell_id, "cancelled", error="cancelled by the user")


def reconcile_stale_cells(connection: sqlite3.Connection) -> int:
    """Recover Cells left mid-flight by a backend that went away.

    The supervisor thread only knows about children spawned in *this* process,
    so a restart orphans whatever was running: `running` becomes failed (the
    executor is gone), `queued` drops back to idle (nothing was lost — it
    never started).
    """
    running = connection.execute("SELECT id FROM cell WHERE status = 'running'").fetchall()
    for row in running:
        set_cell_status(
            connection,
            row["id"],
            "failed",
            error="the backend restarted while this cell was in flight",
        )
    queued = connection.execute("SELECT id FROM cell WHERE status = 'queued'").fetchall()
    for row in queued:
        connection.execute(
            "UPDATE cell SET status = 'idle', queued_at = NULL WHERE id = ?", (row["id"],)
        )
    connection.execute("DELETE FROM cell_queue")
    return len(running) + len(queued)


# --- written by the executor subprocess -------------------------------------


def update_cell_progress(connection: sqlite3.Connection, cell_id: int, progress: dict) -> None:
    connection.execute(
        "UPDATE cell SET progress_json = ? WHERE id = ?",
        (json.dumps(progress), cell_id),
    )


def record_cell_result(connection: sqlite3.Connection, cell_id: int, result: dict) -> None:
    """Overwrite a Cell's result columns with its latest measurement.

    Every executor-owned column is written unconditionally — a re-run replaces
    the previous outcome wholesale, so a failed re-run never leaves stale
    percentiles standing next to a fresh timestamp.
    """
    unknown = set(result) - set(CELL_RESULT_FIELDS)
    if unknown:
        raise ValueError(f"unknown result columns: {sorted(unknown)}")
    payload = {
        key: (json.dumps(value) if key.endswith("_json") and not isinstance(value, str) else value)
        for key, value in result.items()
    }
    # Columns absent from this result must not survive from a previous run.
    for column in CELL_RESULT_FIELDS:
        payload.setdefault(column, None)
    payload["last_run_at"] = _now()
    assignments = ", ".join(f"{column} = ?" for column in payload)
    connection.execute(
        f"UPDATE cell SET {assignments} WHERE id = ?",
        (*payload.values(), cell_id),
    )


def latest_latency_seconds(connection: sqlite3.Connection, deployment_id: int) -> float | None:
    """The most recent completed Cell's typical end-to-end latency.

    Feeds the duration estimate. A guess from this Deployment's own history
    beats a global constant; before the first measurement there is nothing
    better than the constant.
    """
    row = connection.execute(
        """
        SELECT e2e_p50 FROM cell
         WHERE deployment_id = ? AND status = 'completed' AND e2e_p50 IS NOT NULL
         ORDER BY last_run_at DESC
         LIMIT 1
        """,
        (deployment_id,),
    ).fetchone()
    return None if row is None else row["e2e_p50"] / 1000.0


def _json(value: object) -> str | None:
    return None if value is None else json.dumps(value)


# --- comparison --------------------------------------------------------------

CELL_COMPARISON_FIELDS = (
    "id",
    "level",
    "num_requests",
    "total_requests",
    "successful_requests",
    "failed_requests",
    "duration_seconds",
    "offered_qps",
    "achieved_qps",
    "input_token_throughput",
    "output_token_throughput",
    "ttft_p50",
    "ttft_p95",
    "ttft_p99",
    "tpot_p50",
    "tpot_p95",
    "tpot_p99",
    "e2e_p50",
    "e2e_p95",
    "e2e_p99",
    "last_run_at",
    "stale",
)


def comparison_sections(
    connection: sqlite3.Connection, deployment_ids: list[int]
) -> list[dict]:
    """Align the given Deployments' Cells by (workload, mode, level).

    Pairing is by identity: same ``workload_id``, same mode, same level. The
    ladders need not match — the axis is the *union* of levels, and a
    Deployment missing a point contributes ``None`` (rendered 未测). Only
    completed Cells participate.
    """
    placeholders = ", ".join("?" for _ in deployment_ids)
    rows = connection.execute(
        f"""
        SELECT c.*, w.name AS workload_name, w.kind AS workload_kind,
               w.input_tokens AS workload_input_tokens,
               w.output_tokens AS workload_output_tokens,
               w.dataset AS workload_dataset
          FROM cell c
          JOIN workload w ON w.id = c.workload_id
         WHERE c.deployment_id IN ({placeholders})
           AND c.status = 'completed'
         ORDER BY c.level
        """,
        deployment_ids,
    ).fetchall()

    sections: dict[tuple[int, str], dict] = {}
    for raw in rows:
        cell = _cell(dict(raw))
        key = (cell["workload_id"], cell["mode"])
        section = sections.setdefault(
            key,
            {
                "workload": {
                    "id": cell["workload_id"],
                    "name": cell["workload_name"],
                    "kind": cell["workload_kind"],
                    "input_tokens": cell["workload_input_tokens"],
                    "output_tokens": cell["workload_output_tokens"],
                    "dataset": cell["workload_dataset"],
                },
                "mode": cell["mode"],
                "levels": set(),
                "by_deployment": {deployment_id: {} for deployment_id in deployment_ids},
                "tools": set(),
                "executors": set(),
            },
        )
        section["levels"].add(cell["level"])
        snapshot = cell.get("executed_snapshot") or {}
        if snapshot.get("tool"):
            section["tools"].add(snapshot["tool"])
        if snapshot.get("executor"):
            section["executors"].add(snapshot["executor"])
        section["by_deployment"][cell["deployment_id"]][cell["level"]] = {
            field: cell[field] for field in CELL_COMPARISON_FIELDS
        }

    rendered = []
    for (workload_id, mode), section in sorted(sections.items()):
        levels = sorted(section["levels"])
        per_deployment = section["by_deployment"]
        common = set.intersection(
            *(set(cells) for cells in per_deployment.values())
        ) if per_deployment else set()
        rows_out = [
            {
                "level": level,
                "cells": {
                    str(deployment_id): per_deployment[deployment_id].get(level)
                    for deployment_id in deployment_ids
                },
            }
            for level in levels
        ]
        notices = []
        if len(section["tools"]) > 1:
            notices.append(
                "负载发生器版本不一致：" + "、".join(sorted(section["tools"]))
            )
        if len(section["executors"]) > 1:
            notices.append(
                "执行机不一致：" + "、".join(sorted(section["executors"]))
            )
        rendered.append(
            {
                "workload": section["workload"],
                "mode": mode,
                "levels": levels,
                "no_common_levels": not common,
                "notices": notices,
                "rows": rows_out,
            }
        )
    return rendered


# --- services and inspection ------------------------------------------------


def list_services(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute("SELECT * FROM service ORDER BY name").fetchall()
    return [_service_summary(dict(row)) for row in rows]


def _inspection_case_ids() -> list[str]:
    return [case.case_id for case in catalogue()]


def list_inspection_cases(connection: sqlite3.Connection) -> list[dict]:
    settings = {
        row["case_id"]: dict(row)
        for row in connection.execute("SELECT * FROM inspection_case_setting")
    }
    result = []
    for case in case_catalogue():
        case.update(settings.get(case["case_id"], {}))
        case["group"] = case.pop("group_name", None) or case["group"]
        case["default_enabled"] = bool(case["default_enabled"])
        result.append(case)
    return result


def update_inspection_case(connection: sqlite3.Connection, case_id: str, changes: dict) -> dict:
    case = next((c for c in list_inspection_cases(connection) if c["case_id"] == case_id), None)
    if case is None:
        raise NotFound(f"inspection case {case_id} does not exist")
    case.update(changes)
    connection.execute(
        """INSERT INTO inspection_case_setting (case_id, title, timeout_seconds, default_enabled, group_name)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET title=excluded.title,
        timeout_seconds=excluded.timeout_seconds, default_enabled=excluded.default_enabled,
        group_name=excluded.group_name""",
        (case_id, case["title"], case["timeout_seconds"], int(case["default_enabled"]), case["group"]),
    )
    return case


def reset_inspection_cases(connection: sqlite3.Connection) -> list[dict]:
    connection.execute("DELETE FROM inspection_case_setting")
    return list_inspection_cases(connection)


def _service_summary(service: dict) -> dict:
    saved = service.pop("enabled_case_ids_json", None)
    service["enabled_case_ids"] = json.loads(saved) if saved else [case.case_id for case in catalogue() if not case.disruptive]
    return service


def get_service(connection: sqlite3.Connection, service_id: int) -> dict:
    row = connection.execute("SELECT * FROM service WHERE id = ?", (service_id,)).fetchone()
    if row is None:
        raise NotFound(f"service {service_id} does not exist")
    return _service_summary(dict(row))


def set_service_inspection_cases(
    connection: sqlite3.Connection, service_id: int, case_ids: list[str]
) -> dict:
    get_service(connection, service_id)
    available = _inspection_case_ids()
    if not case_ids or len(case_ids) != len(set(case_ids)) or set(case_ids) - set(available):
        raise Invalid("select at least one unique, known inspection case")
    ordered = [case_id for case_id in available if case_id in case_ids]
    connection.execute(
        "UPDATE service SET enabled_case_ids_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(ordered), _now(), service_id),
    )
    return get_service(connection, service_id)


def create_service(connection: sqlite3.Connection, fields: dict) -> dict:
    now = _now()
    try:
        cursor = connection.execute(
            """
            INSERT INTO service (name, note, router_url, api_key_env, created_at, updated_at, enabled_case_ids_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (fields["name"], fields["note"], fields["router_url"], fields["api_key_env"], now, now,
             json.dumps([c["case_id"] for c in list_inspection_cases(connection) if c["default_enabled"]])),
        )
    except sqlite3.IntegrityError as exc:
        raise Conflict(f"a service named {fields['name']!r} already exists") from exc
    return get_service(connection, int(cursor.lastrowid))


def update_service(connection: sqlite3.Connection, service_id: int, changes: dict) -> dict:
    get_service(connection, service_id)
    allowed = {
        key: value
        for key, value in changes.items()
        if key in ("name", "note", "router_url", "api_key_env")
    }
    if allowed:
        assignments = ", ".join(f"{key} = ?" for key in allowed)
        try:
            connection.execute(
                f"UPDATE service SET {assignments}, updated_at = ? WHERE id = ?",
                (*allowed.values(), _now(), service_id),
            )
        except sqlite3.IntegrityError as exc:
            raise Conflict(f"a service named {allowed.get('name')!r} already exists") from exc
    return get_service(connection, service_id)


def active_inspection_urls(connection: sqlite3.Connection) -> set[str]:
    return {
        row["router_url"] for row in connection.execute(
            """SELECT s.router_url FROM inspection_run AS r
               JOIN service AS s ON s.id = r.service_id
               WHERE r.status IN ('queued', 'running')"""
        )
    }


def create_inspection_run(connection: sqlite3.Connection, service_id: int) -> dict:
    service = get_service(connection, service_id)
    if not service["enabled_case_ids"]:
        raise Invalid("请先选择至少一个巡检项目")
    cursor = connection.execute(
        """
        INSERT INTO inspection_run (service_id, suite_version, case_ids_json, status, queued_at)
        VALUES (?, ?, ?, 'queued', ?)
        """,
        (service_id, SUITE_VERSION, json.dumps(service["enabled_case_ids"]), _now()),
    )
    run_id = int(cursor.lastrowid)
    connection.execute(
        "INSERT INTO inspection_run_setting VALUES (?, ?)",
        (run_id, json.dumps([c for c in list_inspection_cases(connection)
                            if c["case_id"] in service["enabled_case_ids"]])),
    )
    return get_inspection_run(connection, run_id)


def list_inspection_runs(connection: sqlite3.Connection, service_id: int) -> list[dict]:
    get_service(connection, service_id)
    rows = connection.execute(
        """SELECT inspection_run.*,
                  (SELECT COUNT(*) FROM inspection_case_result
                   WHERE inspection_run_id = inspection_run.id
                     AND case_id != 'discovery') AS completed_cases
             FROM inspection_run WHERE service_id = ? ORDER BY id DESC""",
        (service_id,),
    ).fetchall()
    runs = []
    for row in rows:
        run = _inspection_summary(dict(row))
        if row["case_ids_json"] is None:
            run["case_ids"] = _legacy_inspection_case_ids(connection, run["id"])
        runs.append(run)
    return runs


def _legacy_inspection_case_ids(connection: sqlite3.Connection, inspection_run_id: int) -> list[str]:
    rows = connection.execute(
        "SELECT case_id FROM inspection_case_result WHERE inspection_run_id = ? "
        "AND case_id != 'discovery' ORDER BY ordinal",
        (inspection_run_id,),
    ).fetchall()
    return [row["case_id"] for row in rows] or _inspection_case_ids()


def get_inspection_run(connection: sqlite3.Connection, inspection_run_id: int) -> dict:
    row = connection.execute(
        "SELECT * FROM inspection_run WHERE id = ?", (inspection_run_id,),
    ).fetchone()
    if row is None:
        raise NotFound(f"inspection run {inspection_run_id} does not exist")
    run = _inspection_summary(dict(row))
    setting = connection.execute(
        "SELECT cases_json FROM inspection_run_setting WHERE inspection_run_id = ?", (inspection_run_id,)
    ).fetchone()
    run["case_settings"] = json.loads(setting["cases_json"]) if setting else []
    if row["case_ids_json"] is None:
        run["case_ids"] = _legacy_inspection_case_ids(connection, inspection_run_id)
    cases = connection.execute(
        "SELECT * FROM inspection_case_result WHERE inspection_run_id = ? ORDER BY ordinal",
        (inspection_run_id,),
    ).fetchall()
    run["cases"] = [
        {
            **dict(case),
            "required": bool(case["required"]),
            "evidence": json.loads(case["evidence_json"] or "[]"),
        }
        for case in cases
    ]
    for case in run["cases"]:
        case.pop("evidence_json", None)
    run["completed_cases"] = sum(
        case["case_id"] in run["case_ids"] for case in run["cases"]
    )
    return run


def delete_inspection_run(connection: sqlite3.Connection, inspection_run_id: int) -> None:
    row = connection.execute(
        "SELECT status FROM inspection_run WHERE id = ?", (inspection_run_id,)
    ).fetchone()
    if row is None:
        raise NotFound(f"inspection run {inspection_run_id} does not exist")
    if row["status"] not in TERMINAL_STATUSES:
        raise Conflict(f"inspection {inspection_run_id} is {row['status']}; cancel it before deleting")
    cursor = connection.execute(
        "DELETE FROM inspection_run WHERE id = ? AND status IN ('completed', 'failed', 'cancelled')",
        (inspection_run_id,),
    )
    if cursor.rowcount != 1:
        raise Conflict(f"inspection {inspection_run_id} changed before it could be deleted")


def _inspection_summary(run: dict) -> dict:
    progress = run.pop("progress_json", None)
    run["progress"] = json.loads(progress) if progress else None
    run["target"] = json.loads(run.pop("target_json", None) or "null")
    run["case_ids"] = json.loads(run.pop("case_ids_json", None) or "null") or _inspection_case_ids()
    return run


def set_inspection_status(
    connection: sqlite3.Connection,
    inspection_run_id: int,
    status: str,
    *,
    error: str | None = None,
    verdict: str | None = None,
    suite_version: str | None = None,
    target: dict | None = None,
    pid: int | None = None,
) -> bool:
    """Backend-owned, guarded the same way a Cell's status is."""
    now = _now()
    guard = " AND status NOT IN ('completed', 'failed', 'cancelled')"
    cursor = connection.execute(
        f"""
        UPDATE inspection_run
           SET status = ?,
               error = ?,
               verdict = COALESCE(?, verdict),
               suite_version = COALESCE(?, suite_version),
               target_json = COALESCE(?, target_json),
               pid = COALESCE(?, pid),
               started_at = COALESCE(?, started_at),
               finished_at = COALESCE(?, finished_at)
         WHERE id = ?{guard}
        """,
        (
            status,
            error,
            verdict,
            suite_version,
            json.dumps(target) if target is not None else None,
            pid,
            now if status == "running" else None,
            now if status in TERMINAL_STATUSES else None,
            inspection_run_id,
        ),
    )
    return cursor.rowcount == 1


def record_inspection_case(
    connection: sqlite3.Connection, inspection_run_id: int, ordinal: int, case: dict
) -> None:
    """Executor-owned, like a cell result."""
    connection.execute(
        """
        INSERT INTO inspection_case_result (
            inspection_run_id, ordinal, case_id, required, verdict, reason_code, message, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (inspection_run_id, ordinal) DO UPDATE SET
            case_id = excluded.case_id,
            required = excluded.required,
            verdict = excluded.verdict,
            reason_code = excluded.reason_code,
            message = excluded.message,
            evidence_json = COALESCE(excluded.evidence_json, inspection_case_result.evidence_json)
        """,
        (
            inspection_run_id,
            ordinal,
            case["case_id"],
            1 if case["required"] else 0,
            case["verdict"],
            case["reason_code"],
            case.get("message", ""),
            json.dumps(case["evidence"]) if "evidence" in case else None,
        ),
    )


def update_inspection_progress(
    connection: sqlite3.Connection, inspection_run_id: int, *, current_case: str | None = None
) -> None:
    connection.execute(
        """
        UPDATE inspection_run
           SET current_case = COALESCE(?, current_case),
               progress_json = ?
         WHERE id = ?
        """,
        (current_case, json.dumps({"current_case": current_case}), inspection_run_id),
    )


def cancel_inspection_run(connection: sqlite3.Connection, inspection_run_id: int) -> bool:
    return set_inspection_status(connection, inspection_run_id, "cancelled", error="cancelled by the user")


def reconcile_stale_inspections(connection: sqlite3.Connection) -> int:
    rows = connection.execute(
        "SELECT id FROM inspection_run WHERE status IN ('running', 'queued')"
    ).fetchall()
    for row in rows:
        set_inspection_status(
            connection,
            row["id"],
            "failed",
            error="the backend restarted while this inspection was in flight",
            verdict="ERROR",
        )
    return len(rows)
