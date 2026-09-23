"""The app under a real ASGI server.

Starlette's ``TestClient`` runs the whole thing on one thread, which hides a
class of bug that only appears in production: FastAPI executes sync
dependencies and sync handlers in a **threadpool**, and a request's setup,
body and teardown may each land on a different worker. A SQLite connection
created on one worker and closed on another raises ``ProgrammingError``.

That failure reached a live browser before these tests existed, so this file
exists specifically to make it impossible again.
"""

from __future__ import annotations

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import uvicorn

from server.app import create_app

CONCURRENCY = 8
REQUESTS = 48


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    port = free_port()
    app = create_app(tmp_path_factory.mktemp("live") / "live.db")
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:
        pytest.fail("uvicorn did not start")

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=10)


def test_concurrent_requests_survive_the_threadpool(live_server):
    """Many requests at once, so the threadpool actually rotates workers."""

    def read(_: int) -> int:
        return httpx.get(f"{live_server}/api/models", timeout=10).status_code

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        codes = list(pool.map(read, range(REQUESTS)))

    assert set(codes) == {200}


def test_concurrent_writes_all_succeed(live_server):
    def write(index: int) -> int:
        response = httpx.post(
            f"{live_server}/api/models", json={"name": f"model-{index}"}, timeout=10
        )
        return response.status_code

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        codes = list(pool.map(write, range(REQUESTS)))

    assert set(codes) == {201}
    names = [m["name"] for m in httpx.get(f"{live_server}/api/models", timeout=10).json()]
    assert len(names) == REQUESTS


def test_a_read_and_a_write_interleaved_stay_consistent(live_server):
    """The shape a person actually produces, rather than a uniform load."""
    with httpx.Client(base_url=live_server, timeout=10) as client:
        model = client.post("/api/models", json={"name": "interleaved"}).json()
        for index in range(5):
            assert client.get("/api/models").status_code == 200
            created = client.post(
                f"/api/models/{model['id']}/deployments",
                json={
                    "name": f"d{index}",
                    "router_url": "http://host:9000",
                    "model_name": "m",
                },
            )
            assert created.status_code == 201, created.text
        deployments = client.get(f"/api/models/{model['id']}/deployments").json()
        assert len(deployments) == 5
