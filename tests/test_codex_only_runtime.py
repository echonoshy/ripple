from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.codex_chat import build_codex_chat_prompt
from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager, get_server_tool_names
from ripple.agent_runners.approvals import codex_approval_response_for_action, parse_codex_approval_request
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.sandbox.nsjail_config import generate_nsjail_config
from ripple.skills.loader import invalidate_shared_cache, invalidate_workspace_cache


def _client(tmp_path) -> TestClient:
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(sandbox_config)
    session_manager = SessionManager(sandbox_manager=sandbox_manager)
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(session_manager)
    return TestClient(app, headers={"X-Ripple-User-Id": "alice"})


class RecordingApprovalManager:
    def __init__(self):
        self.calls = []

    def resolve_approval(self, job_id, request_id, action):
        self.calls.append((job_id, request_id, action))
        return True


def test_server_tool_names_are_empty_in_codex_only_runtime():
    assert get_server_tool_names() == []


def test_info_reports_no_model_facing_tools(tmp_path):
    response = _client(tmp_path).get("/v1/info")

    assert response.status_code == 200
    assert response.json()["tools"] == []


def test_removed_legacy_execution_routes_return_404(tmp_path):
    client = _client(tmp_path)

    responses = [
        client.post("/v1/tools/invoke", json={"tool": "Bash", "args": {"command": "pwd"}}),
        client.get("/v1/sandbox/schedules"),
        client.post("/v1/sandbox/schedules/job-123/run"),
    ]

    assert [response.status_code for response in responses] == [404, 404, 404]


def test_codex_prompt_includes_shared_and_workspace_skill_manifest(tmp_path):
    shared_root = tmp_path / "shared-skills"
    shared_skill = shared_root / "public-skill"
    shared_skill.mkdir(parents=True)
    (shared_skill / "SKILL.md").write_text(
        "---\nname: public-skill\ndescription: Public skill\nwhen-to-use: Public work\n---\nBody\n",
        encoding="utf-8",
    )

    from ripple.utils.config import get_config

    config = get_config()
    skills_config = config._data.setdefault("skills", {})
    previous_shared_dirs = list(skills_config.get("shared_dirs", []))
    skills_config["shared_dirs"] = [str(shared_root)]
    invalidate_shared_cache()

    try:
        sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
        sandbox_manager = SandboxManager(sandbox_config)
        session_manager = SessionManager(sandbox_manager=sandbox_manager)
        session = session_manager.create_session(user_id="alice")
        workspace_skill = sandbox_config.workspace_dir("alice") / "skills" / "custom-skill"
        workspace_skill.mkdir(parents=True)
        (workspace_skill / "SKILL.md").write_text(
            "---\nname: custom-skill\ndescription: Custom skill\n---\nBody\n",
            encoding="utf-8",
        )
        invalidate_workspace_cache(sandbox_config.workspace_dir("alice"))

        prompt = build_codex_chat_prompt(session=session, user_input="Use a skill", system_prompt="system")

        assert "## Available Skills" in prompt
        assert "public-skill (shared)" in prompt
        assert str(shared_skill / "SKILL.md") in prompt
        assert "custom-skill (workspace)" in prompt
        assert str(workspace_skill / "SKILL.md") in prompt
    finally:
        skills_config["shared_dirs"] = previous_shared_dirs
        invalidate_shared_cache()


def test_nsjail_mounts_shared_skills_at_stable_sandbox_path(tmp_path):
    shared_root = tmp_path / "shared-skills"
    shared_root.mkdir()

    from ripple.utils.config import get_config

    config = get_config()
    skills_config = config._data.setdefault("skills", {})
    previous_shared_dirs = list(skills_config.get("shared_dirs", []))
    skills_config["shared_dirs"] = [str(shared_root)]
    invalidate_shared_cache()

    try:
        sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
        sandbox_config.workspace_dir("alice").mkdir(parents=True)

        nsjail_config = generate_nsjail_config(sandbox_config, "alice")

        assert f'src: "{shared_root}"' in nsjail_config
        assert 'dst: "/opt/ripple/skills/shared/0-shared-skills"' in nsjail_config
    finally:
        skills_config["shared_dirs"] = previous_shared_dirs
        invalidate_shared_cache()


def test_codex_command_approval_request_parser_and_response_mapping():
    message = {
        "id": "approval-1",
        "method": "item/commandExecution/requestApproval",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "command": "rm -rf build",
            "cwd": "/workspace",
            "reason": "needs confirmation",
        },
    }

    approval = parse_codex_approval_request(
        message,
        job_id="agent-1",
        user_id="alice",
        session_id="srv-1",
    )

    assert approval is not None
    assert approval["source"] == "codex"
    assert approval["request_id"] == "approval-1"
    assert approval["action"] == "command_execution"
    assert approval["description"] == "rm -rf build"
    assert approval["metadata"]["reason"] == "needs confirmation"
    assert codex_approval_response_for_action(approval, "allow") == {"decision": "accept"}
    assert codex_approval_response_for_action(approval, "always") == {"decision": "acceptForSession"}
    assert codex_approval_response_for_action(approval, "deny") == {"decision": "decline"}


def test_session_permission_resolve_forwards_codex_approval(tmp_path, monkeypatch):
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(sandbox_config)
    session_manager = SessionManager(sandbox_manager=sandbox_manager)
    session = session_manager.create_session(user_id="alice")
    session.pending_permission_request = {
        "source": "codex",
        "job_id": "agent-1",
        "request_id": "approval-1",
        "description": "rm -rf build",
    }
    approval_manager = RecordingApprovalManager()
    monkeypatch.setattr("interfaces.server.routes.get_external_agent_manager", lambda: approval_manager)

    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(session_manager)
    client = TestClient(app, headers={"X-Ripple-User-Id": "alice"})

    response = client.post(f"/v1/sessions/{session.session_id}/permissions/resolve", json={"action": "allow"})

    assert response.status_code == 200
    assert response.json() == {"ok": True, "action": "allow", "forwarded": True}
    assert approval_manager.calls == [("agent-1", "approval-1", "allow")]
    assert session.pending_permission_request is None
