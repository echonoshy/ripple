import json

import pytest

from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN, SandboxConfig
from ripple.sandbox.gogcli import configured_gogcli_client_secret_json
from ripple.sandbox.gogcli_registration import GogcliClientRegistrationError, register_gogcli_client_config
from ripple.tools.builtin.gogcli_login_start import GoogleWorkspaceLoginStartTool


class DummyConfig:
    def __init__(self, values: dict[str, object]):
        self._values = values

    def get(self, key: str, default=None):
        return self._values.get(key, default)


def test_configured_gogcli_client_secret_json_builds_web_client_from_settings():
    callback_url = "https://ripple.example/v1/sandboxes/gogcli/oauth/callback"
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.client": {
                "client_id": "123.apps.googleusercontent.com",
                "client_secret": "secret-value",
                "project_id": "ripple-prod",
                "redirect_uris": ["https://old.example/callback"],
            }
        }
    )

    raw = configured_gogcli_client_secret_json(cfg, callback_url=callback_url)

    assert raw is not None
    payload = json.loads(raw)
    assert payload == {
        "web": {
            "client_id": "123.apps.googleusercontent.com",
            "client_secret": "secret-value",
            "project_id": "ripple-prod",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "redirect_uris": ["https://old.example/callback", callback_url],
        }
    }


def test_configured_gogcli_client_secret_json_prefers_raw_json():
    raw_client = {
        "web": {
            "client_id": "raw.apps.googleusercontent.com",
            "client_secret": "raw-secret",
        }
    }
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.client_secret_json": json.dumps(raw_client),
            "server.gogcli_oauth.client": {
                "client_id": "ignored.apps.googleusercontent.com",
                "client_secret": "ignored",
            },
        }
    )

    raw = configured_gogcli_client_secret_json(cfg, callback_url="https://ripple.example/callback")

    assert raw is not None
    assert json.loads(raw) == raw_client


def test_configured_gogcli_client_secret_json_returns_none_without_global_client():
    assert configured_gogcli_client_secret_json(DummyConfig({})) is None


async def test_login_start_without_deployment_client_reports_server_configuration_error(tmp_path, monkeypatch):
    import ripple.tools.builtin.bash as bash_module
    import ripple.tools.builtin.gogcli_login_start as login_start

    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        gogcli_cli_install_root="/opt/gogcli",
    )
    callback_url = "https://ripple.example/v1/sandboxes/gogcli/oauth/callback"

    class FakeContext:
        user_id = "alice"
        request_public_base_url = "https://ripple.example"

    monkeypatch.setattr(bash_module, "_sandbox_config", config)
    monkeypatch.setattr(login_start, "configured_gogcli_client_secret_json", lambda **_kwargs: None)
    monkeypatch.setattr(login_start, "resolve_gogcli_oauth_callback_url", lambda **_kwargs: callback_url)

    result = await GoogleWorkspaceLoginStartTool().call({"email": "alice@example.com"}, FakeContext(), None)

    assert result.data["ok"] is False
    error = result.data["error"]
    assert "[GOGCLI_SERVER_OAUTH_CLIENT_REQUIRED]" in error
    assert "server.gogcli_oauth.client" in error
    assert callback_url in error
    for forbidden in (
        "GOGCLI_CLIENT_CONFIG_REQUIRED",
        "GoogleWorkspaceClientConfigSet",
        "Google Cloud Console",
        "GCP Console",
        "OAuth Client",
        "client_secret.json",
        "下载",
        "粘贴",
        "手工绑定",
        "fallback",
    ):
        assert forbidden not in error


async def test_register_gogcli_client_config_writes_and_registers_user_client(tmp_path, monkeypatch):
    import ripple.sandbox.gogcli_registration as registration

    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        gogcli_cli_install_root="/opt/gogcli",
    )
    raw_client = json.dumps(
        {
            "web": {
                "client_id": "123.apps.googleusercontent.com",
                "client_secret": "secret-value",
            }
        }
    )
    calls = []

    async def fake_execute_in_sandbox(command, sandbox_config, user_id, timeout):
        calls.append((command, sandbox_config, user_id, timeout))
        return "", "", 0

    monkeypatch.setattr(registration, "execute_in_sandbox", fake_execute_in_sandbox)
    monkeypatch.setattr(registration, "write_nsjail_config", lambda *_args, **_kwargs: None)

    client = await register_gogcli_client_config(config, "alice", raw_client)

    assert client.client_id == "123.apps.googleusercontent.com"
    assert config.has_gogcli_client_config("alice") is True
    assert config.gogcli_keyring_pass_file("alice").exists()
    assert calls == [
        (
            "mkdir -p $XDG_CONFIG_HOME/gogcli && "
            f"{GOGCLI_CLI_SANDBOX_BIN} auth credentials /workspace/.config/gogcli/.pending-client.json && "
            "rm -f /workspace/.config/gogcli/.pending-client.json",
            config,
            "alice",
            30,
        )
    ]
    assert not (config.workspace_dir("alice") / ".config" / "gogcli" / ".pending-client.json").exists()


async def test_register_gogcli_client_config_removes_new_client_when_registration_fails(tmp_path, monkeypatch):
    import ripple.sandbox.gogcli_registration as registration

    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        gogcli_cli_install_root="/opt/gogcli",
    )
    raw_client = json.dumps(
        {
            "web": {
                "client_id": "bad.apps.googleusercontent.com",
                "client_secret": "bad-secret",
            }
        }
    )

    async def fake_execute_in_sandbox(command, sandbox_config, user_id, timeout):
        return "", "invalid client", 1

    monkeypatch.setattr(registration, "execute_in_sandbox", fake_execute_in_sandbox)
    monkeypatch.setattr(registration, "write_nsjail_config", lambda *_args, **_kwargs: None)

    with pytest.raises(GogcliClientRegistrationError):
        await register_gogcli_client_config(config, "alice", raw_client)

    assert config.has_gogcli_client_config("alice") is False
    assert not (config.workspace_dir("alice") / ".config" / "gogcli" / ".pending-client.json").exists()


async def test_login_start_auto_registers_global_client_before_oauth_step_one(tmp_path, monkeypatch):
    import ripple.sandbox.gogcli_registration as registration
    import ripple.tools.builtin.bash as bash_module
    import ripple.tools.builtin.gogcli_login_start as login_start

    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        gogcli_cli_install_root="/opt/gogcli",
    )
    raw_client = json.dumps(
        {
            "web": {
                "client_id": "global.apps.googleusercontent.com",
                "client_secret": "global-secret",
            }
        }
    )
    calls = []
    callback_url = "https://ripple.example/v1/sandboxes/gogcli/oauth/callback"

    async def fake_register_execute(command, sandbox_config, user_id, timeout):
        calls.append(("register", command, sandbox_config, user_id, timeout))
        return "", "", 0

    async def fake_login_execute(command, sandbox_config, user_id, timeout):
        calls.append(("login", command, sandbox_config, user_id, timeout))
        return "Open https://accounts.google.com/o/oauth2/auth?state=state-123&scope=email", "", 0

    class FakeContext:
        user_id = "alice"
        request_public_base_url = "https://ripple.example"

    monkeypatch.setattr(bash_module, "_sandbox_config", config)
    monkeypatch.setattr(registration, "execute_in_sandbox", fake_register_execute)
    monkeypatch.setattr(registration, "write_nsjail_config", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(login_start, "execute_in_sandbox", fake_login_execute)
    monkeypatch.setattr(login_start, "write_nsjail_config", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(login_start, "configured_gogcli_client_secret_json", lambda **_kwargs: raw_client)
    monkeypatch.setattr(login_start, "resolve_gogcli_oauth_callback_url", lambda **_kwargs: callback_url)

    result = await GoogleWorkspaceLoginStartTool().call({"email": "alice@example.com"}, FakeContext(), None)

    assert result.data["ok"] is True
    assert result.data["callback_mode"] == "assisted"
    assert config.has_gogcli_client_config("alice") is True
    assert calls[0][0] == "register"
    assert calls[1] == (
        "login",
        f"{GOGCLI_CLI_SANDBOX_BIN} auth add 'alice@example.com' "
        "--services gmail,drive,calendar,docs,sheets,slides --remote --step 1 "
        f"--redirect-uri '{callback_url}'",
        config,
        "alice",
        20,
    )
