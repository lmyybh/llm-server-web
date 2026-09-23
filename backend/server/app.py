"""The HTTP API.

A Model owns Deployments; a Deployment identifies one already-running Target
Service. A Workload is a global, preset load shape; a Cell is one measurement
point at a (Deployment, Workload, mode, level) combination. Nothing here
starts, stops, or scales the Target Service — its lifecycle is outside this
tool's ownership by design.
"""

from __future__ import annotations

import io
import sqlite3
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import TypeVar

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from llmbench import datasets
from llmbench.datasets import DatasetError

from . import estimate, store, supervisor
from .config import ARTIFACTS_ROOT, CORS_ORIGIN_REGEX, CORS_ORIGINS, database_path
from .schemas import (
    CellBatchCreate,
    CellsRunRequest,
    CellUpdate,
    DeploymentCreate,
    DeploymentUpdate,
    ModelCreate,
    ModelUpdate,
    ServiceCreate,
    ServiceUpdate,
    WorkloadCreate,
    WorkloadUpdate,
    deployment_field_defaults,
)
from .security import UNSAFE_METHODS, origin_is_allowed

T = TypeVar("T")

router = APIRouter(prefix="/api")


def connection_for(request: Request) -> Iterator[sqlite3.Connection]:
    connection = store.connect(request.app.state.db_path)
    try:
        yield connection
    finally:
        connection.close()


Connection = Depends(connection_for)


def _guard(call: Callable[..., T], *args, **kwargs) -> T:
    """Map store-level exceptions onto HTTP status codes in one place."""
    try:
        return call(*args, **kwargs)
    except store.NotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except store.Conflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except store.Invalid as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


# --- models ----------------------------------------------------------------


@router.get("/models")
def list_models(connection: sqlite3.Connection = Connection) -> list[dict]:
    return store.list_models(connection)


@router.post("/models", status_code=status.HTTP_201_CREATED)
def create_model(payload: ModelCreate, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.create_model, connection, payload.name, payload.note)


@router.get("/models/{model_id}")
def get_model(model_id: int, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.get_model, connection, model_id)


@router.patch("/models/{model_id}")
def update_model(
    model_id: int, payload: ModelUpdate, connection: sqlite3.Connection = Connection
) -> dict:
    return _guard(store.update_model, connection, model_id, payload.model_dump(exclude_unset=True))


# --- deployments -----------------------------------------------------------


@router.get("/models/{model_id}/deployments")
def list_deployments(model_id: int, connection: sqlite3.Connection = Connection) -> list[dict]:
    return _guard(store.list_deployments, connection, model_id)


@router.delete("/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(model_id: int, connection: sqlite3.Connection = Connection):
    _guard(store.delete_model, connection, model_id)


@router.post("/models/{model_id}/deployments", status_code=status.HTTP_201_CREATED)
def create_deployment(
    model_id: int, payload: DeploymentCreate, connection: sqlite3.Connection = Connection
) -> dict:
    """A field the caller omits falls back to its built-in default — nothing
    else intervenes between the payload and the stored row."""
    _guard(store.get_model, connection, model_id)
    fields = {
        **deployment_field_defaults(),
        **payload.model_dump(exclude_unset=True),
    }
    return _guard(store.create_deployment, connection, model_id, fields)


@router.get("/deployments/{deployment_id}")
def get_deployment(deployment_id: int, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.get_deployment, connection, deployment_id)


@router.patch("/deployments/{deployment_id}")
def update_deployment(
    deployment_id: int, payload: DeploymentUpdate, connection: sqlite3.Connection = Connection
) -> dict:
    return _guard(
        store.update_deployment, connection, deployment_id, payload.model_dump(exclude_unset=True)
    )


# --- workloads (global library) --------------------------------------------


@router.get("/workloads")
def list_workloads(connection: sqlite3.Connection = Connection) -> list[dict]:
    return store.list_workloads(connection)


@router.post("/workloads", status_code=status.HTTP_201_CREATED)
def create_workload(payload: WorkloadCreate, connection: sqlite3.Connection = Connection) -> dict:
    if payload.kind == "dataset":
        # A bad dataset name is a rejection now, not a failed Cell later.
        try:
            datasets.load(payload.dataset)
        except DatasetError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return _guard(store.create_workload, connection, payload.model_dump())


@router.get("/workloads/{workload_id}")
def get_workload(workload_id: int, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.get_workload, connection, workload_id)


@router.patch("/workloads/{workload_id}")
def update_workload(
    workload_id: int,
    payload: WorkloadUpdate,
    connection: sqlite3.Connection = Connection,
) -> dict:
    return _guard(
        store.update_workload, connection, workload_id, payload.model_dump(exclude_unset=True)
    )


@router.delete("/workloads/{workload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workload(workload_id: int, connection: sqlite3.Connection = Connection):
    _guard(store.delete_workload, connection, workload_id)


# --- deployment ↔ workload attachments ---------------------------------------


@router.get("/deployments/{deployment_id}/workloads")
def list_deployment_workloads(
    deployment_id: int, connection: sqlite3.Connection = Connection
) -> list[dict]:
    return _guard(store.list_deployment_workloads, connection, deployment_id)


@router.put("/deployments/{deployment_id}/workloads/{workload_id}", status_code=status.HTTP_201_CREATED)
def attach_workload(
    deployment_id: int, workload_id: int, connection: sqlite3.Connection = Connection
) -> dict:
    """Add a Workload to a Deployment without choosing any bench configuration."""
    return _guard(store.attach_workload, connection, deployment_id, workload_id)


@router.delete("/deployments/{deployment_id}/workloads/{workload_id}", status_code=status.HTTP_204_NO_CONTENT)
def detach_workload(
    deployment_id: int, workload_id: int, connection: sqlite3.Connection = Connection
):
    _guard(store.detach_workload, connection, deployment_id, workload_id)


# --- cells ------------------------------------------------------------------


@router.get("/deployments/{deployment_id}/cells")
def list_cells(deployment_id: int, connection: sqlite3.Connection = Connection) -> list[dict]:
    return _guard(store.list_cells, connection, deployment_id)


@router.post("/deployments/{deployment_id}/cells", status_code=status.HTTP_201_CREATED)
def create_cells(
    deployment_id: int,
    payload: CellBatchCreate,
    connection: sqlite3.Connection = Connection,
) -> list[dict]:
    workload = _guard(store.get_workload, connection, payload.workload_id)
    if workload["kind"] == "dataset":
        try:
            datasets.load(workload["dataset"])
        except DatasetError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return _guard(
        store.create_cells,
        connection,
        deployment_id,
        workload_id=payload.workload_id,
        mode=payload.mode,
        levels=payload.levels,
        num_requests=payload.num_requests,
    )


@router.get("/cells/{cell_id}")
def get_cell(cell_id: int, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.get_cell, connection, cell_id)


@router.patch("/cells/{cell_id}")
def update_cell(
    cell_id: int, payload: CellUpdate, connection: sqlite3.Connection = Connection
) -> dict:
    return _guard(store.update_cell, connection, cell_id, payload.model_dump())


@router.delete("/cells/{cell_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cell(cell_id: int, connection: sqlite3.Connection = Connection):
    _guard(store.delete_cell, connection, cell_id)


@router.delete("/deployments/{deployment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_deployment(deployment_id: int, connection: sqlite3.Connection = Connection):
    _guard(store.delete_deployment, connection, deployment_id)


@router.post("/cells/{cell_id}/run")
def run_cell(cell_id: int, request: Request, connection: sqlite3.Connection = Connection) -> dict:
    """Queue one Cell. A running or already-queued Cell refuses with 409:
    re-running means overwriting, and overwriting in-flight data is not a
    thing a button should do silently."""
    cell = _guard(store.queue_cell, connection, cell_id)
    supervisor.submit(request.app.state.db_path, cell["id"])
    return store.get_cell(connection, cell["id"])


@router.post("/cells/run")
def run_cells(
    payload: CellsRunRequest, request: Request, connection: sqlite3.Connection = Connection
) -> list[dict]:
    """Queue several Cells ("跑全部"). All are validated before any is queued,
    so a batch never half-enters the queue."""
    cells = [_guard(store.get_cell, connection, cell_id) for cell_id in payload.cell_ids]
    for cell in cells:
        if cell["status"] not in store.RUNNABLE_CELL_STATUSES:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"cell {cell['id']} is {cell['status']}; it cannot be started now",
            )
    for cell in cells:
        store.queue_cell(connection, cell["id"])
    if cells:
        supervisor.submit(request.app.state.db_path, cells[0]["id"])
    return [store.get_cell(connection, cell["id"]) for cell in cells]


@router.post("/cells/{cell_id}/cancel")
def cancel_cell(
    cell_id: int, request: Request, connection: sqlite3.Connection = Connection
) -> dict:
    cell = _guard(store.get_cell, connection, cell_id)
    if cell["status"] in store.TERMINAL_STATUSES or cell["status"] == "idle":
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"cell {cell_id} is {cell['status']}, nothing to cancel"
        )
    if not supervisor.cancel(request.app.state.db_path, cell_id):
        # Lost the race with the executor finishing on its own. Not an error —
        # but the caller should re-read rather than assume it was cancelled.
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"cell {cell_id} finished before it could be cancelled"
        )
    return store.get_cell(connection, cell_id)


# --- estimate ---------------------------------------------------------------


@router.post("/deployments/{deployment_id}/estimate")
def estimate_cells(
    deployment_id: int,
    payload: CellBatchCreate,
    connection: sqlite3.Connection = Connection,
) -> dict:
    """What this ladder would cost in wall clock, before creating anything."""
    _guard(store.get_deployment, connection, deployment_id)
    known = store.latest_latency_seconds(connection, deployment_id)
    seconds = 0.0
    guessed = known is None
    for level, requests in zip(payload.levels, payload.request_counts()):
        cell_secs, _, _ = estimate.cells_seconds(
            mode=payload.mode,
            levels=[level],
            num_requests=requests,
            latency_seconds=known,
        )
        seconds += cell_secs
    return {
        "estimated_seconds": round(seconds, 1),
        "cell_count": len(payload.levels),
        "request_count": sum(payload.request_counts()),
        "latency_seconds": round(known or estimate.DEFAULT_LATENCY_SECONDS, 2),
        "latency_is_estimated": guessed,
    }


# --- comparison --------------------------------------------------------------


def _deployment_ids(raw: str) -> list[int]:
    try:
        ids = sorted({int(part) for part in raw.split(",") if part.strip()})
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "deployment_ids must be comma-separated integers",
        ) from exc
    if len(ids) < 2:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "a comparison needs at least two deployments"
        )
    return ids


@router.get("/compare")
def compare(model_id: int, deployment_ids: str, connection: sqlite3.Connection = Connection) -> dict:
    """Cells aligned by (workload, mode, level) across Deployments.

    Comparison is a judgement, not a human decision: same workload identity,
    same mode, same level — anything else does not sit on one chart.
    Strictly within one Model: across Models the difference comes from the
    model itself, not the deployment.
    """
    _guard(store.get_model, connection, model_id)
    ids = _deployment_ids(deployment_ids)
    deployments = [_guard(store.get_deployment, connection, deployment_id) for deployment_id in ids]
    for deployment in deployments:
        if deployment["model_id"] != model_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"deployment {deployment['id']} belongs to model {deployment['model_id']}, "
                f"not {model_id}; comparisons are only meaningful within one model",
            )
    return {
        "deployments": [
            {"id": deployment["id"], "name": deployment["name"]} for deployment in deployments
        ],
        "sections": store.comparison_sections(connection, ids),
    }


# --- services and inspection -------------------------------------------------


@router.get("/services")
def list_services(connection: sqlite3.Connection = Connection) -> list[dict]:
    return store.list_services(connection)


@router.post("/services", status_code=status.HTTP_201_CREATED)
def create_service(payload: ServiceCreate, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.create_service, connection, payload.model_dump())


@router.get("/services/{service_id}")
def get_service(service_id: int, connection: sqlite3.Connection = Connection) -> dict:
    return _guard(store.get_service, connection, service_id)


@router.patch("/services/{service_id}")
def update_service(
    service_id: int, payload: ServiceUpdate, connection: sqlite3.Connection = Connection
) -> dict:
    return _guard(
        store.update_service, connection, service_id, payload.model_dump(exclude_unset=True)
    )


@router.get("/services/{service_id}/inspections")
def list_inspections(service_id: int, connection: sqlite3.Connection = Connection) -> list[dict]:
    return _guard(store.list_inspection_runs, connection, service_id)


@router.post("/services/{service_id}/inspections", status_code=status.HTTP_201_CREATED)
def start_inspection(
    service_id: int, request: Request, connection: sqlite3.Connection = Connection
) -> dict:
    run = _guard(store.create_inspection_run, connection, service_id)
    supervisor.spawn_inspection(request.app.state.db_path, run["id"])
    return store.get_inspection_run(connection, run["id"])


@router.get("/inspections/{inspection_run_id}")
def get_inspection(
    inspection_run_id: int, connection: sqlite3.Connection = Connection
) -> dict:
    return _guard(store.get_inspection_run, connection, inspection_run_id)


@router.post("/inspections/{inspection_run_id}/cancel")
def cancel_inspection(
    inspection_run_id: int, request: Request, connection: sqlite3.Connection = Connection
) -> dict:
    run = _guard(store.get_inspection_run, connection, inspection_run_id)
    if run["status"] in store.TERMINAL_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"inspection {inspection_run_id} is already {run['status']}"
        )
    if not store.cancel_inspection_run(connection, inspection_run_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "it finished before it could be cancelled")
    if run["pid"]:
        supervisor.terminate(run["pid"])
    return store.get_inspection_run(connection, inspection_run_id)


# --- datasets ---------------------------------------------------------------


@router.get("/datasets")
def list_datasets() -> list[dict]:
    """The registered business datasets.

    ``exists`` is checked rather than assumed: a registry entry pointing at a
    file that has since moved is worth seeing before a Cell is queued, not
    after.
    """
    try:
        registered = datasets.registry()
    except DatasetError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
    return [
        {"name": dataset.name, "path": str(dataset.path), "exists": dataset.path.is_file()}
        for dataset in sorted(registered.values(), key=lambda entry: entry.name)
    ]


# --- artifacts --------------------------------------------------------------


def _artifact_directory(cell: dict) -> Path | None:
    """The Cell's artifact directory, or None.

    Resolved and checked against the artifacts root: the path is stored in the
    database, and a stored path is just a value until something verifies it
    still points where it is supposed to.
    """
    if not cell.get("artifact_dir"):
        return None
    directory = Path(cell["artifact_dir"]).resolve()
    root = ARTIFACTS_ROOT.resolve()
    if not directory.is_relative_to(root):
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "this cell's artifact directory is outside the artifacts root",
        )
    return directory


@router.get("/cells/{cell_id}/artifacts")
def list_artifacts(cell_id: int, connection: sqlite3.Connection = Connection) -> dict:
    cell = _guard(store.get_cell, connection, cell_id)
    directory = _artifact_directory(cell)
    if directory is None or not directory.is_dir():
        return {"cell_id": cell_id, "files": [], "total_bytes": 0}

    files = [
        {"name": str(path.relative_to(directory)), "bytes": path.stat().st_size}
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    ]
    return {
        "cell_id": cell_id,
        "directory": str(directory),
        "files": files,
        "total_bytes": sum(entry["bytes"] for entry in files),
    }


@router.get("/cells/{cell_id}/artifacts.zip")
def download_artifacts(cell_id: int, connection: sqlite3.Connection = Connection) -> Response:
    """Everything this Cell produced, as one file.

    The point of keeping it: a measurement definition that turns out to be
    wrong can be corrected and the number recomputed from these, where the
    database's aggregates would only let it be regretted.
    """
    cell = _guard(store.get_cell, connection, cell_id)
    directory = _artifact_directory(cell)
    if directory is None or not directory.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"cell {cell_id} has no artifacts")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(directory))
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="cell-{cell_id}-artifacts.zip"',
            "Content-Length": str(buffer.getbuffer().nbytes),
        },
    )


def create_app(db_path: Path | None = None) -> FastAPI:
    """Build the app. The database is created and migrated on construction."""
    app = FastAPI(title="LLM Bench & Inspection", version="0.2.0")
    app.state.db_path = Path(db_path) if db_path is not None else database_path()
    connection = store.connect(app.state.db_path)
    try:
        # Nothing survives a restart: the supervisor threads are gone, so any
        # Cell still marked in-flight has no executor behind it. Say so rather
        # than leaving it spinning for ever.
        store.reconcile_stale_cells(connection)
        store.reconcile_stale_inspections(connection)
    finally:
        connection.close()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_origin_regex=CORS_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _reject_unaccounted_writes(request: Request, call_next):
        if request.method in UNSAFE_METHODS:
            # Behind a gateway the Host is ours but the browser's Origin is the
            # gateway's, so X-Forwarded-Host is what makes them comparable.
            host = request.headers.get("x-forwarded-host") or request.headers.get("host")
            if not origin_is_allowed(request.headers.get("origin"), host):
                return JSONResponse(
                    {
                        "detail": (
                            "this Origin is not allowed to make write requests; "
                            "add it to LLMBENCH_ALLOWED_ORIGINS if it is legitimate"
                        )
                    },
                    status_code=status.HTTP_403_FORBIDDEN,
                )
        return await call_next(request)

    app.include_router(router)
    return app


app = create_app()
