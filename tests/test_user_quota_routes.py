from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


class DummySessionManager:
    def __init__(self, sandbox_manager):
        self.sandbox_manager = sandbox_manager

    def create_session(self, **kwargs):
        user_id = kwargs["user_id"]
        session_id = f"session-{len(self.sandbox_manager.list_user_sessions(user_id)) + 1}"
        self.sandbox_manager.setup_session(user_id, session_id)
        meta = self.sandbox_manager.config.session_dir(user_id, session_id) / "meta.json"
        meta.write_text("{}", encoding="utf-8")

        class Session:
            messages = []
            session_id = "session-1"
            model = "codex-medium"

            from datetime import datetime, timezone

            created_at = datetime.now(timezone.utc)
            last_active = created_at

        session = Session()
        session.session_id = session_id
        return session


def _client(tmp_path: Path, monkeypatch, user_id: str = "alice") -> tuple[TestClient, SandboxManager]:
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(config)
    sandbox_manager.ensure_sandbox(user_id)
    monkeypatch.setattr(
        "interfaces.server.routes.get_external_agent_manager",
        lambda: ExternalAgentManager(providers={}),
    )
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(DummySessionManager(sandbox_manager))
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), sandbox_manager


def test_user_quota_defaults_are_created_on_first_access(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path, monkeypatch)

    response = client.get("/v1/users/me/quota")

    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "alice"
    assert body["quota"]["max_workspace_mb"] == 2048
    assert body["usage"]["workspace_size_bytes"] == 0
    assert (sandbox_manager.config.sandbox_dir("alice") / "user.json").exists()


def test_run_creation_rejects_runtime_above_quota(tmp_path: Path, monkeypatch):
    client, _sandbox_manager = _client(tmp_path, monkeypatch)
    update = client.put("/v1/users/alice/quota", json={"max_run_runtime_seconds": 10})
    assert update.status_code == 200

    response = client.post(
        "/v1/runs",
        json={"prompt": "hello", "provider": "codex", "max_runtime_seconds": 11},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "quota_exceeded"
    assert response.json()["detail"]["resource"] == "run_runtime_seconds"


def test_run_creation_rejects_when_daily_run_quota_is_exhausted(tmp_path: Path, monkeypatch):
    client, _sandbox_manager = _client(tmp_path, monkeypatch)
    update = client.put("/v1/users/alice/quota", json={"max_runs_per_day": 0})
    assert update.status_code == 200

    response = client.post("/v1/runs", json={"prompt": "hello", "provider": "codex"})

    assert response.status_code == 403
    assert response.json()["detail"]["resource"] == "runs_per_day"


def test_session_creation_rejects_when_session_quota_is_exhausted(tmp_path: Path, monkeypatch):
    client, _sandbox_manager = _client(tmp_path, monkeypatch)
    update = client.put("/v1/users/alice/quota", json={"max_sessions": 0})
    assert update.status_code == 200

    response = client.post("/v1/sessions", json={})

    assert response.status_code == 403
    assert response.json()["detail"]["resource"] == "sessions"


def test_workspace_save_rejects_when_workspace_quota_would_be_exceeded(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path, monkeypatch)
    workspace = sandbox_manager.config.workspace_dir("alice")
    target = workspace / "notes.txt"
    target.write_text("", encoding="utf-8")
    update = client.put("/v1/users/alice/quota", json={"max_workspace_mb": 0})
    assert update.status_code == 200

    response = client.put("/v1/workspace/file", json={"path": "/workspace/notes.txt", "content": "x"})

    assert response.status_code == 403
    assert response.json()["detail"]["resource"] == "workspace_bytes"
    assert target.read_text(encoding="utf-8") == ""
