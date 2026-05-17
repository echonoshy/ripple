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


def test_workspace_route_creates_empty_workspace_before_sandbox_exists(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)

    response = client.get("/v1/workspace")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "/workspace"
    assert body["entries"] == []
    assert sandbox_manager.config.workspace_dir("alice").is_dir()


def test_workspace_search_route_returns_matching_files(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "src").mkdir()
    (workspace / "src" / "TaskComposer.tsx").write_text("export default null", encoding="utf-8")
    (workspace / "README.md").write_text("# Hello", encoding="utf-8")

    response = client.get("/v1/workspace/search", params={"q": "composer"})

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "composer"
    assert body["count"] == 1
    assert body["entries"][0]["path"] == "/workspace/src/TaskComposer.tsx"


def test_workspace_search_route_accepts_filter_params(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "src").mkdir()
    (workspace / "docs").mkdir()
    (workspace / "src" / "app.ts").write_text("shared needle", encoding="utf-8")
    (workspace / "docs" / "guide.md").write_text("shared needle", encoding="utf-8")

    response = client.get(
        "/v1/workspace/search",
        params={"q": "shared", "scope": "content", "file_type": "markdown"},
    )

    assert response.status_code == 200
    body = response.json()
    assert [entry["path"] for entry in body["entries"]] == ["/workspace/docs/guide.md"]


def test_workspace_search_route_creates_empty_workspace_before_sandbox_exists(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)

    response = client.get("/v1/workspace/search", params={"q": "anything"})

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "anything"
    assert body["count"] == 0
    assert body["entries"] == []
    assert sandbox_manager.config.workspace_dir("alice").is_dir()


def test_workspace_rename_route_supports_files_and_directories(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "notes.txt").write_text("hello", encoding="utf-8")
    (workspace / "drafts").mkdir()

    file_response = client.post(
        "/v1/workspace/rename",
        json={"path": "/workspace/notes.txt", "name": "README.md"},
    )
    dir_response = client.post(
        "/v1/workspace/rename",
        json={"path": "/workspace/drafts", "name": "docs"},
    )

    assert file_response.status_code == 200
    assert file_response.json()["path"] == "/workspace/README.md"
    assert (workspace / "README.md").read_text(encoding="utf-8") == "hello"
    assert dir_response.status_code == 200
    assert dir_response.json()["path"] == "/workspace/docs"
    assert (workspace / "docs").is_dir()


def test_workspace_rename_route_rejects_conflicting_names(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "notes.txt").write_text("hello", encoding="utf-8")
    (workspace / "README.md").write_text("existing", encoding="utf-8")

    response = client.post(
        "/v1/workspace/rename",
        json={"path": "/workspace/notes.txt", "name": "README.md"},
    )

    assert response.status_code == 409
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "hello"


def test_workspace_rename_route_creates_workspace_before_reporting_missing_path(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)

    response = client.post(
        "/v1/workspace/rename",
        json={"path": "/workspace/missing.txt", "name": "README.md"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Path not found"
    assert sandbox_manager.config.workspace_dir("alice").is_dir()


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


def test_upload_workspace_attachment_saves_file_under_user_workspace(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)

    response = client.post(
        "/v1/workspace/attachments",
        files={"file": ("photo.png", b"\x89PNG\r\n\x1a\nimage-bytes", "image/png")},
        data={"kind": "image"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["path"].startswith("/workspace/.ripple/uploads/")
    assert body["path"].endswith("-photo.png")
    assert body["name"] == "photo.png"
    assert body["mime_type"] == "image/png"
    assert body["size"] == len(b"\x89PNG\r\n\x1a\nimage-bytes")
    assert body["kind"] == "image"
    assert "host_path" not in body

    workspace = sandbox_manager.config.workspace_dir("alice")
    host_path = workspace / body["path"].removeprefix("/workspace/")
    assert host_path.is_file()
    assert host_path.read_bytes() == b"\x89PNG\r\n\x1a\nimage-bytes"


def test_upload_workspace_attachment_sanitizes_path_traversal_filename(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)

    response = client.post(
        "/v1/workspace/attachments",
        files={"file": ("../secret.txt", b"secret", "text/plain")},
        data={"kind": "attachment"},
    )

    assert response.status_code == 200
    body = response.json()
    assert ".." not in body["path"]
    assert body["path"].endswith("-secret.txt")

    workspace = sandbox_manager.config.workspace_dir("alice")
    host_path = workspace / body["path"].removeprefix("/workspace/")
    assert host_path.is_file()
    assert host_path.read_bytes() == b"secret"
