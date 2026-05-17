from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager, SessionStatus
from ripple.messages.utils import create_assistant_message, create_user_message
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


def _client(tmp_path: Path, monkeypatch, user_id: str = "alice") -> tuple[TestClient, SessionManager]:
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(sandbox_config)
    session_manager = SessionManager(sandbox_manager=sandbox_manager)

    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(session_manager)
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), session_manager


def test_task_list_maps_existing_sessions_to_task_summaries(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)
    session = session_manager.create_session(user_id="alice", model="codex-medium")
    session.messages.append(create_user_message("Refactor auth flow"))
    session_manager.touch_session(session)

    response = client.get("/v1/tasks")

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    task = body["tasks"][0]
    assert task["task_id"] == session.session_id
    assert task["session_id"] == session.session_id
    assert task["title"] == "Refactor auth flow"
    assert task["model"] == "codex-medium"
    assert task["message_count"] == 1
    assert task["status"] == "idle"
    assert task["changed_file_count"] == 0
    assert task["pending_approval_count"] == 0


def test_task_detail_returns_messages_and_pending_permission(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)
    session = session_manager.create_session(user_id="alice", model="codex-medium")
    session.messages.append(create_user_message("Update backend task API"))
    session.messages.append(create_assistant_message([{"type": "text", "text": "Working on it"}]))
    session.status = SessionStatus.RUNNING
    session.pending_permission_request = {
        "source": "codex",
        "job_id": "job-1",
        "request_id": "approval-1",
        "summary": "Run command",
    }

    response = client.get(f"/v1/tasks/{session.session_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["task_id"] == session.session_id
    assert body["session_id"] == session.session_id
    assert body["status"] == "waiting_for_approval"
    assert body["pending_approval_count"] == 1
    assert body["pending_permission_request"]["job_id"] == "job-1"
    assert [message["type"] for message in body["messages"]] == ["user", "assistant"]
    assert body["pending_question"] is None
    assert body["pending_options"] is None


def test_task_create_returns_session_backed_summary_and_ensures_sandbox(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)

    response = client.post("/v1/tasks", json={"model": "codex-medium", "max_turns": None, "system_prompt": None})

    assert response.status_code == 200
    body = response.json()
    assert body["task_id"].startswith("srv-")
    assert body["session_id"] == body["task_id"]
    assert body["model"] == "codex-medium"
    assert body["message_count"] == 0
    assert body["status"] == "idle"
    assert session_manager.sandbox_manager is not None
    assert session_manager.sandbox_manager.config.workspace_dir("alice").exists()


def test_task_delete_removes_backing_session(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)
    session = session_manager.create_session(user_id="alice", model="codex-medium")
    session.messages.append(create_user_message("Delete me"))

    response = client.delete(f"/v1/tasks/{session.session_id}")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "task_id": session.session_id, "session_id": session.session_id}
    assert session_manager.get_session(session.session_id, user_id="alice") is None


def test_task_clear_context_removes_messages_model_messages_and_pending_state(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)
    session = session_manager.create_session(user_id="alice", model="codex-medium")
    session.messages.append(create_user_message("Keep this only until clear"))
    session.messages.append(create_assistant_message([{"type": "text", "text": "Done"}]))
    session.model_messages = list(session.messages)
    session.pending_question = "Continue?"
    session.pending_options = ["yes", "no"]
    session.pending_permission_request = {"source": "codex", "job_id": "job-1", "request_id": "approval-1"}
    session.total_input_tokens = 123
    session.total_output_tokens = 45
    session_manager.persist_session(session)

    response = client.post(f"/v1/tasks/{session.session_id}/context/clear")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "task_id": session.session_id,
        "session_id": session.session_id,
        "message_count": 0,
    }
    assert session.messages == []
    assert session.model_messages == []
    assert session.pending_question is None
    assert session.pending_options is None
    assert session.pending_permission_request is None
    assert session.total_input_tokens == 0
    assert session.total_output_tokens == 0

    detail = client.get(f"/v1/tasks/{session.session_id}").json()
    assert detail["message_count"] == 0
    assert detail["messages"] == []

    session_manager.suspend_session(session.session_id, user_id="alice")
    resumed = session_manager.resume_session(session.session_id, user_id="alice")
    assert resumed is not None
    assert resumed.messages == []
    assert resumed.model_messages == []


def test_task_stop_delegates_to_session_stop(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)
    session = session_manager.create_session(user_id="alice", model="codex-medium")

    class RunningTask:
        cancelled = False

        def done(self):
            return False

        def cancel(self):
            self.cancelled = True

    task = RunningTask()
    session.current_task = task

    response = client.post(f"/v1/tasks/{session.session_id}/stop")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "stopped": True,
        "task_id": session.session_id,
        "session_id": session.session_id,
    }
    assert task.cancelled is True


def test_task_permission_resolve_forwards_codex_approval(tmp_path: Path, monkeypatch):
    client, session_manager = _client(tmp_path, monkeypatch)
    session = session_manager.create_session(user_id="alice", model="codex-medium")
    session.status = SessionStatus.AWAITING_PERMISSION
    session.pending_permission_request = {
        "source": "codex",
        "job_id": "job-1",
        "request_id": "approval-1",
    }

    class ApprovalManager:
        def __init__(self):
            self.calls = []

        def resolve_approval(self, job_id, request_id, action):
            self.calls.append((job_id, request_id, action))
            return True

    approval_manager = ApprovalManager()
    monkeypatch.setattr("interfaces.server.routes.get_external_agent_manager", lambda: approval_manager)

    response = client.post(f"/v1/tasks/{session.session_id}/permissions/resolve", json={"action": "always"})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "action": "always",
        "forwarded": True,
        "task_id": session.session_id,
        "session_id": session.session_id,
    }
    assert approval_manager.calls == [("job-1", "approval-1", "always")]
    assert session.pending_permission_request is None
    assert session.status == SessionStatus.RUNNING
