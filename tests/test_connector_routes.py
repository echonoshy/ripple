import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from ripple.connectors import registry
from ripple.connectors.registry import codex_cli_login_status
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


def test_connector_list_exposes_supported_connector_names(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")

    response = client.get("/v1/connectors")

    assert response.status_code == 200
    connectors = response.json()["connectors"]
    names = [connector["name"] for connector in connectors]
    assert names == ["google_workspace", "notion", "feishu", "bilibili", "openai_codex"]
    notion = next(connector for connector in connectors if connector["name"] == "notion")
    assert notion["auth_start_path"] == "/v1/connectors/notion/auth/start"
    assert notion["disconnect_path"] == "/v1/connectors/notion/disconnect"
    google = next(connector for connector in connectors if connector["name"] == "google_workspace")
    assert google["accounts_path"] == "/v1/connectors/google_workspace/accounts"
    feishu = next(connector for connector in connectors if connector["name"] == "feishu")
    assert feishu["auth_complete_path"] == "/v1/connectors/feishu/auth/complete"


def test_notion_connector_auth_start_binds_token_without_echoing_it(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    token = "ntn_" + "x" * 40

    response = client.post("/v1/connectors/notion/auth/start", json={"api_token": token})

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "notion"
    assert body["ok"] is True
    assert body["stage"] == "authorized"
    assert token not in response.text
    assert sandbox_manager.config.has_notion_token("alice") is True
    assert sandbox_manager.config.nsjail_cfg_file("alice").exists()

    status = client.get("/v1/connectors/notion/status")
    assert status.status_code == 200
    assert status.json()["connected"] is True


def test_notion_connector_disconnect_removes_token(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.ensure_sandbox("alice")
    notion_file = sandbox_manager.config.notion_config_file("alice")
    notion_file.parent.mkdir(parents=True, exist_ok=True)
    notion_file.write_text(json.dumps({"api_token": "ntn_test"}), encoding="utf-8")

    response = client.post("/v1/connectors/notion/disconnect")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["data"]["credential_removed"] is True
    assert sandbox_manager.config.has_notion_token("alice") is False


def test_feishu_connector_auth_start_returns_device_flow_url(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        assert user_id == "alice"
        assert force_new_setup is False
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert user_id == "alice"
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-123",
            "expires_in_seconds": 600,
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth, raising=False)

    response = client.post("/v1/connectors/feishu/auth/start", json={})

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "feishu"
    assert body["ok"] is True
    assert body["stage"] == "awaiting_user_auth"
    assert body["data"]["oauth_url"] == "https://accounts.feishu.cn/device"
    assert body["data"]["device_code"] == "device-123"


def test_feishu_connector_auth_start_requests_fresh_device_flow_each_click(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    calls: list[bool] = []

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        assert user_id == "alice"
        assert force_new_setup is False
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert user_id == "alice"
        calls.append(force_new)
        index = len(calls)
        return True, {
            "oauth_url": f"https://accounts.feishu.cn/device/{index}",
            "device_code": f"device-{index}",
            "expires_in_seconds": 600,
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth, raising=False)

    first = client.post("/v1/connectors/feishu/auth/start", json={})
    second = client.post("/v1/connectors/feishu/auth/start", json={})

    assert first.status_code == 200
    assert second.status_code == 200
    assert calls == [True, True]
    assert first.json()["data"]["oauth_url"] == "https://accounts.feishu.cn/device/1"
    assert second.json()["data"]["oauth_url"] == "https://accounts.feishu.cn/device/2"


def test_feishu_connector_auth_start_reuses_pending_setup_by_default(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    force_new_setup_values: list[bool] = []

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        assert user_id == "alice"
        force_new_setup_values.append(force_new_setup)
        return False, "https://open.feishu.cn/page/cli?user_code=SETUP"

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)

    response = client.post("/v1/connectors/feishu/auth/start", json={})

    assert response.status_code == 200
    assert force_new_setup_values == [False]
    body = response.json()
    assert body["stage"] == "awaiting_setup"
    assert body["data"]["setup_url"] == "https://open.feishu.cn/page/cli?user_code=SETUP"


def test_feishu_connector_auth_start_can_resume_pending_setup_without_restart(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    force_new_setup_values: list[bool] = []

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        assert user_id == "alice"
        force_new_setup_values.append(force_new_setup)
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert user_id == "alice"
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device/resumed",
            "device_code": "device-resumed",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth, raising=False)

    response = client.post("/v1/connectors/feishu/auth/start", json={"force_new": False})

    assert response.status_code == 200
    assert force_new_setup_values == [False]
    body = response.json()
    assert body["stage"] == "awaiting_user_auth"
    assert body["data"]["device_code"] == "device-resumed"


def test_feishu_connector_auth_complete_exchanges_device_code(tmp_path: Path, monkeypatch):
    client, sandbox_manager = _client(tmp_path)
    sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    captured: dict[str, str] = {}

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        captured["user_id"] = user_id
        captured["device_code"] = device_code
        return True, "authorized"

    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth, raising=False)

    response = client.post("/v1/connectors/feishu/auth/complete", json={"device_code": "device-123"})

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "feishu"
    assert body["ok"] is True
    assert body["stage"] == "authorized"
    assert captured == {"user_id": "alice", "device_code": "device-123"}


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
