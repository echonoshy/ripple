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
    sandbox_manager.ensure_sandbox(user_id)
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(DummySessionManager(sandbox_manager))
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), sandbox_manager


def test_document_metadata_can_be_created_for_workspace_file(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.config.workspace_dir("alice")
    (workspace / "brief.md").write_text("# Brief", encoding="utf-8")

    response = client.post(
        "/v1/documents",
        json={
            "title": "Project brief",
            "path": "/workspace/brief.md",
            "linked_session_id": "session-1",
            "summary": "Initial project notes",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["document_id"].startswith("doc-")
    assert body["kind"] == "markdown"
    assert body["path"] == "/workspace/brief.md"
    assert (sandbox_manager.config.sandbox_dir("alice") / "documents" / "index.json").exists()


def test_document_create_rejects_path_outside_workspace(tmp_path: Path):
    client, _sandbox_manager = _client(tmp_path)

    response = client.post("/v1/documents", json={"title": "Bad", "path": "/tmp/bad.md"})

    assert response.status_code == 403


def test_document_list_filters_by_metadata_query(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.config.workspace_dir("alice")
    (workspace / "brief.md").write_text("# Brief", encoding="utf-8")
    (workspace / "notes.txt").write_text("notes", encoding="utf-8")
    client.post("/v1/documents", json={"title": "Project brief", "path": "/workspace/brief.md"})
    client.post("/v1/documents", json={"title": "Meeting notes", "path": "/workspace/notes.txt"})

    response = client.get("/v1/documents", params={"q": "brief"})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["documents"][0]["title"] == "Project brief"


def test_document_patch_and_delete_do_not_delete_workspace_file(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.config.workspace_dir("alice")
    target = workspace / "brief.md"
    target.write_text("# Brief", encoding="utf-8")
    created = client.post("/v1/documents", json={"title": "Project brief", "path": "/workspace/brief.md"}).json()
    document_id = created["document_id"]

    patched = client.patch(
        f"/v1/documents/{document_id}",
        json={"title": "Updated brief", "summary": "Reviewed", "linked_session_id": "session-2"},
    )
    deleted = client.delete(f"/v1/documents/{document_id}")
    listing = client.get("/v1/documents")

    assert patched.status_code == 200
    assert patched.json()["title"] == "Updated brief"
    assert patched.json()["summary"] == "Reviewed"
    assert deleted.status_code == 200
    assert deleted.json()["ok"] is True
    assert listing.json()["count"] == 0
    assert target.exists()
