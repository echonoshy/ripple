from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


class DummySessionManager:
    def __init__(self, sandbox_manager):
        self.sandbox_manager = sandbox_manager


def _client(tmp_path: Path, user_id: str = "alice") -> tuple[TestClient, SandboxManager]:
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(config)
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(DummySessionManager(sandbox_manager))
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), sandbox_manager


def test_workspace_route_lists_current_user_workspace(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "src").mkdir()
    (workspace / "README.md").write_text("# Hello", encoding="utf-8")

    response = client.get("/v1/workspace")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "/workspace"
    assert [entry["name"] for entry in body["entries"]] == ["src", "README.md"]


def test_workspace_route_returns_404_before_sandbox_exists(tmp_path: Path):
    client, _sandbox_manager = _client(tmp_path)

    response = client.get("/v1/workspace")

    assert response.status_code == 404


def test_workspace_file_route_previews_text(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "notes.txt").write_text("abcdef", encoding="utf-8")

    response = client.get("/v1/workspace/file", params={"path": "/workspace/notes.txt", "limit": 3})

    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "abc"
    assert body["truncated"] is True


def test_workspace_file_route_saves_text_with_modified_at_guard(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    target = workspace / "notes.txt"
    target.write_text("before", encoding="utf-8")
    preview = client.get("/v1/workspace/file", params={"path": "/workspace/notes.txt"}).json()

    response = client.put(
        "/v1/workspace/file",
        json={
            "path": "/workspace/notes.txt",
            "content": "after\n",
            "expected_modified_at": preview["modified_at"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "after\n"
    assert body["truncated"] is False
    assert target.read_text(encoding="utf-8") == "after\n"


def test_workspace_file_route_rejects_stale_save(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    target = workspace / "notes.txt"
    target.write_text("current", encoding="utf-8")

    response = client.put(
        "/v1/workspace/file",
        json={
            "path": "/workspace/notes.txt",
            "content": "overwrite",
            "expected_modified_at": "2000-01-01T00:00:00+00:00",
        },
    )

    assert response.status_code == 409
    assert target.read_text(encoding="utf-8") == "current"
