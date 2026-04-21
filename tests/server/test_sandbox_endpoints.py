"""/v1/sandboxes 三个端点：POST / GET / DELETE"""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    from interfaces.server.routes import router, set_session_manager
    from interfaces.server.sessions import SessionManager
    from ripple.sandbox import manager as mgr
    from ripple.sandbox.config import SandboxConfig
    from ripple.sandbox.manager import SandboxManager

    monkeypatch.setattr(mgr, "check_nsjail_available", lambda path: None)

    sbx_cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        sessions_root=tmp_path / "sessions",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    sbx_mgr = SandboxManager(sbx_cfg)
    session_mgr = SessionManager(sandbox_manager=sbx_mgr)
    set_session_manager(session_mgr)

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


AUTH = "Bearer rk-ripple-2026"
HEADERS = {"X-Ripple-User-Id": "alice", "Authorization": AUTH}


def test_post_sandbox_idempotent(client):
    r1 = client.post("/v1/sandboxes", headers=HEADERS)
    r2 = client.post("/v1/sandboxes", headers=HEADERS)
    assert r1.status_code == 200
    assert r2.status_code == 200
    body = r1.json()
    assert body["user_id"] == "alice"
    assert body["session_count"] == 0
    assert body["has_python_venv"] is False


def test_get_sandbox_summary(client):
    client.post("/v1/sandboxes", headers=HEADERS)
    r = client.get("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 200
    data = r.json()
    assert data["user_id"] == "alice"
    assert data["session_count"] == 0


def test_get_sandbox_404_when_missing(client):
    r = client.get("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 404


def test_delete_sandbox(client):
    client.post("/v1/sandboxes", headers=HEADERS)
    r = client.delete("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 200
    assert r.json()["user_id"] == "alice"
    r2 = client.get("/v1/sandboxes", headers=HEADERS)
    assert r2.status_code == 404


def test_delete_missing_sandbox_404(client):
    r = client.delete("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 404


def test_delete_default_sandbox_forbidden(client):
    h = {"X-Ripple-User-Id": "default", "Authorization": AUTH}
    client.post("/v1/sandboxes", headers=h)
    r = client.delete("/v1/sandboxes", headers=h)
    assert r.status_code == 409


def test_sandbox_per_user_isolation(client):
    h_alice = {"X-Ripple-User-Id": "alice", "Authorization": AUTH}
    h_bob = {"X-Ripple-User-Id": "bob", "Authorization": AUTH}
    client.post("/v1/sandboxes", headers=h_alice)
    client.post("/v1/sandboxes", headers=h_bob)

    client.delete("/v1/sandboxes", headers=h_alice)

    r_alice = client.get("/v1/sandboxes", headers=h_alice)
    r_bob = client.get("/v1/sandboxes", headers=h_bob)
    assert r_alice.status_code == 404
    assert r_bob.status_code == 200
    assert r_bob.json()["user_id"] == "bob"
