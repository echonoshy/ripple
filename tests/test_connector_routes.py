import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager, SessionStatus
from ripple.connectors import registry
from ripple.connectors.registry import codex_cli_login_status
from ripple.messages.utils import create_user_message
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


class DummySessionManager:
    def __init__(self, sandbox_manager):
        self.sandbox_manager = sandbox_manager


def _client(tmp_path: Path, user_id: str = "alice") -> tuple[TestClient, SandboxManager]:
    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
    )
    sandbox_manager = SandboxManager(config)
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(DummySessionManager(sandbox_manager))
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), sandbox_manager


def _client_with_session_manager(
    tmp_path: Path,
    user_id: str = "alice",
) -> tuple[TestClient, SandboxManager, SessionManager]:
    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
    )
    sandbox_manager = SandboxManager(config)
    session_manager = SessionManager(sandbox_manager=sandbox_manager)
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(session_manager)
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), sandbox_manager, session_manager


def test_connector_list_exposes_supported_connector_names(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")

    response = client.get("/v1/connectors")

    assert response.status_code == 200
    connectors = response.json()["connectors"]
    names = [connector["name"] for connector in connectors]
    assert names == [
        "google_workspace",
        "notion",
        "feishu",
        "bilibili",
        "openai_codex",
        "codex_image_generation",
        "codex_image_input",
        "codex_web_search",
    ]
    notion = next(connector for connector in connectors if connector["name"] == "notion")
    assert notion["auth_start_path"] is None
    assert notion["disconnect_path"] is None
    assert notion["kind"] == "user_connector"
    assert notion["auth_flow"] == "token"
    assert notion["auth_surfaces"] == {"web": False, "chat": True}
    google = next(connector for connector in connectors if connector["name"] == "google_workspace")
    assert google["auth_start_path"] is None
    assert google["auth_complete_path"] is None
    assert google["disconnect_path"] is None
    assert google["accounts_path"] == "/v1/connectors/google_workspace/accounts"
    assert google["auth_flow"] == "oauth_assisted"
    assert google["auth_surfaces"] == {"web": False, "chat": True}
    feishu = next(connector for connector in connectors if connector["name"] == "feishu")
    assert feishu["auth_start_path"] is None
    assert feishu["auth_complete_path"] is None
    assert feishu["disconnect_path"] is None
    assert feishu["auth_flow"] == "oauth_device"
    assert feishu["auth_surfaces"] == {"web": False, "chat": True}
    codex = next(connector for connector in connectors if connector["name"] == "openai_codex")
    assert codex["kind"] == "runtime_capability"
    assert codex["auth_surfaces"] == {"web": False, "chat": False}
    image_generation = next(connector for connector in connectors if connector["name"] == "codex_image_generation")
    assert image_generation["kind"] == "runtime_capability"
    assert image_generation["auth_flow"] == "none"


def test_connector_auth_actions_are_not_available_through_web_routes(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")
    token = "ntn_" + "x" * 40
    called: list[str] = []

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        called.append("ensure_lark_cli_config")
        return True, ""

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)

    for path, payload in (
        ("/v1/connectors/notion/auth/start", {"api_token": token}),
        ("/v1/connectors/notion/disconnect", {}),
        ("/v1/connectors/feishu/auth/start", {}),
        ("/v1/connectors/feishu/auth/complete", {"device_code": "device-123"}),
        ("/v1/connectors/google_workspace/auth/start", {"email": "alice@example.com"}),
        ("/v1/connectors/google_workspace/auth/complete", {"email": "alice@example.com", "callback_url": "x"}),
        ("/v1/connectors/bilibili/auth/start", {}),
        ("/v1/connectors/bilibili/auth/complete", {"qrcode_key": "qr-123"}),
    ):
        response = client.post(path, json=payload)
        assert response.status_code == 405
        assert "only available through chat" in response.json()["detail"]

    assert sandbox_manager.config.has_notion_token("alice") is False
    assert called == []


def test_connected_connector_status_clears_pending_chat_session(tmp_path: Path):
    client, sandbox_manager, session_manager = _client_with_session_manager(tmp_path)
    session = session_manager.create_session(user_id="alice", model="codex-medium")
    session.messages.append(create_user_message("Use Notion"))
    session.status = SessionStatus.AWAITING_USER_INPUT
    session.pending_connector_auth = {"connector": "notion", "stage": "awaiting_token"}
    session_manager.persist_session(session)
    notion_file = sandbox_manager.config.notion_config_file("alice")
    notion_file.parent.mkdir(parents=True, exist_ok=True)
    notion_file.write_text(json.dumps({"api_token": "ntn_test"}), encoding="utf-8")

    response = client.get("/v1/connectors/notion/status")

    assert response.status_code == 200
    assert response.json()["connected"] is True
    assert session.pending_connector_auth is None
    assert session.status == SessionStatus.IDLE


def test_feishu_cli_login_status_requires_user_auth_evidence(tmp_path: Path, monkeypatch):
    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        lark_cli_bin=str(tmp_path / "lark-cli"),
    )
    cli_config = config.workspace_dir("alice") / ".lark-cli" / "config.json"
    cli_config.parent.mkdir(parents=True, exist_ok=True)
    cli_config.write_text("{}", encoding="utf-8")

    class FakeCompletedProcess:
        def __init__(self, stdout: str, returncode: int = 0):
            self.stdout = stdout
            self.stderr = ""
            self.returncode = returncode

    def fake_run(argv, **kwargs):
        command = argv[-1]
        if "doctor" in command:
            return FakeCompletedProcess(
                json.dumps(
                    {
                        "checks": [
                            {"name": "config_file", "status": "pass"},
                            {"name": "app_resolved", "status": "pass"},
                            {"name": "token_exists", "status": "pass"},
                        ]
                    }
                )
            )
        assert "auth status" in command
        return FakeCompletedProcess(json.dumps({"ok": True}))

    monkeypatch.setattr(registry, "write_nsjail_config", lambda config, user_id: None)
    monkeypatch.setattr(registry, "build_nsjail_argv", lambda config, user_id, command: ["sh", "-c", command])
    monkeypatch.setattr(registry.subprocess, "run", fake_run)

    connected, detail, metadata = registry.feishu_cli_login_status(config, "alice")

    assert connected is False
    assert detail == "Feishu user authorization status is inconclusive."
    assert metadata["has_app_config"] is True
    assert metadata["doctor_checks"]["token_exists"] == "pass"


def test_connector_status_reads_current_user_sandbox_credentials(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")
    notion_file = sandbox_manager.config.notion_config_file("alice")
    notion_file.parent.mkdir(parents=True, exist_ok=True)
    notion_file.write_text(json.dumps({"api_token": "ntn_test"}), encoding="utf-8")

    response = client.get("/v1/connectors/notion/status")

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "notion"
    assert body["connected"] is True
    assert body["required"] is False


def test_codex_connector_status_uses_cli_login_not_legacy_shared_credentials(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")
    legacy_file = tmp_path / ".ripple" / "credentials" / "openai-codex.json"
    legacy_file.parent.mkdir(parents=True, exist_ok=True)
    legacy_file.write_text(json.dumps({"access": "legacy", "refresh": "legacy", "expires": 9999999999999}))

    monkeypatch.setattr(
        "ripple.connectors.registry.codex_cli_login_status",
        lambda: (False, "Codex CLI is not logged in.", {"auth_source": "codex_cli"}),
    )

    response = client.get("/v1/connectors/openai_codex/status")

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "openai_codex"
    assert body["connected"] is False
    assert body["required"] is True
    assert body["detail"] == "Codex CLI is not logged in."
    assert body["metadata"]["auth_source"] == "codex_cli"


def test_codex_cli_login_status_uses_configured_service_codex_home(tmp_path: Path, monkeypatch):
    codex_home = tmp_path / "codex-home"
    probe_file = tmp_path / "probe.txt"
    fake_codex = tmp_path / "codex"
    fake_codex.write_text(
        f"""#!/bin/sh
printf '%s' "$CODEX_HOME" > {probe_file}
echo "Logged in using ChatGPT"
""",
        encoding="utf-8",
    )
    fake_codex.chmod(0o755)

    class FakeConfig:
        def get(self, key: str, default=None):
            values = {
                "external_agents.codex.codex_executable": str(fake_codex),
                "external_agents.codex.codex_home": str(codex_home),
            }
            return values.get(key, default)

    monkeypatch.setattr("ripple.utils.config.get_config", lambda: FakeConfig())

    connected, detail, metadata = codex_cli_login_status()

    assert connected is True
    assert detail == "Codex CLI is logged in for the server user."
    assert metadata["codex_home"] == str(codex_home)
    assert probe_file.read_text(encoding="utf-8") == str(codex_home)


def test_connector_status_returns_404_for_unknown_connector(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")

    response = client.get("/v1/connectors/unknown/status")

    assert response.status_code == 404
