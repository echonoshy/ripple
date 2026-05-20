import asyncio
import json

import pytest

from ripple.sandbox import feishu
from ripple.sandbox.config import SandboxConfig


class FakeProcess:
    def __init__(self):
        self.returncode = None
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        return self.returncode


class PendingProcess:
    def __init__(self):
        self.returncode = None
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        if self.returncode is not None:
            return self.returncode
        await asyncio.sleep(10)
        return self.returncode


@pytest.mark.asyncio
async def test_check_feishu_setup_detects_config_before_process_exit(tmp_path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    process = PendingProcess()
    feishu._feishu_setup_states["alice"] = feishu._FeishuSetupState(
        process=process,
        url="https://setup.example/pending",
    )
    lark_config = config.workspace_dir("alice") / ".lark-cli" / "config.json"
    lark_config.parent.mkdir(parents=True, exist_ok=True)
    lark_config.write_text(json.dumps({"app_id": "cli_a"}), encoding="utf-8")

    try:
        ok, msg = await feishu._check_feishu_setup(config, "alice")
    finally:
        feishu._feishu_setup_states.pop("alice", None)

    assert ok is True
    assert msg == ""
    assert "alice" not in feishu._feishu_setup_states


@pytest.mark.asyncio
async def test_ensure_lark_cli_config_force_new_setup_replaces_pending_setup_url(tmp_path, monkeypatch):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    config.lark_cli_bin = str(tmp_path / "lark-cli")
    process = FakeProcess()
    feishu._feishu_setup_states["alice"] = feishu._FeishuSetupState(
        process=process,
        url="https://old.example/setup",
    )

    monkeypatch.setattr(feishu, "_get_feishu_credentials", lambda _config, _user_id: None)
    monkeypatch.setattr(feishu, "_get_server_feishu_credentials", lambda: None)

    async def fake_start_feishu_setup(config, user_id):
        assert user_id == "alice"
        return False, "https://new.example/setup"

    monkeypatch.setattr(feishu, "_start_feishu_setup", fake_start_feishu_setup)

    try:
        ok, url = await feishu.ensure_lark_cli_config(config, "alice", force_new_setup=True)
    finally:
        feishu._feishu_setup_states.pop("alice", None)

    assert ok is False
    assert url == "https://new.example/setup"
    assert process.killed is True


@pytest.mark.asyncio
async def test_ensure_lark_cli_config_force_new_setup_removes_stale_config(tmp_path, monkeypatch):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    config.lark_cli_bin = str(tmp_path / "lark-cli")
    lark_config = config.workspace_dir("alice") / ".lark-cli" / "config.json"
    lark_config.parent.mkdir(parents=True, exist_ok=True)
    lark_config.write_text(json.dumps({"app_id": "stale"}), encoding="utf-8")

    monkeypatch.setattr(feishu, "_get_feishu_credentials", lambda _config, _user_id: None)
    monkeypatch.setattr(feishu, "_get_server_feishu_credentials", lambda: None)

    async def fake_start_feishu_setup(config, user_id):
        assert user_id == "alice"
        assert not lark_config.exists()
        return False, "https://new.example/setup"

    monkeypatch.setattr(feishu, "_start_feishu_setup", fake_start_feishu_setup)

    ok, url = await feishu.ensure_lark_cli_config(config, "alice", force_new_setup=True)

    assert ok is False
    assert url == "https://new.example/setup"


@pytest.mark.asyncio
async def test_start_lark_user_auth_force_new_logs_out_before_new_device_flow(tmp_path, monkeypatch):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    config.lark_cli_bin = str(tmp_path / "lark-cli")
    commands: list[tuple[str, int | None]] = []

    async def fake_execute_in_sandbox(command, config, user_id, timeout=None):
        assert user_id == "alice"
        commands.append((command, timeout))
        if command == "lark-cli auth logout":
            return "", "", 0
        return (
            json.dumps(
                {
                    "oauth_url": "https://accounts.feishu.cn/device/new",
                    "device_code": "device-new",
                    "expires_in_seconds": 600,
                }
            ),
            "",
            0,
        )

    monkeypatch.setattr(feishu, "execute_in_sandbox", fake_execute_in_sandbox)

    ok, payload = await feishu.start_lark_user_auth(config, "alice", force_new=True)

    assert ok is True
    assert payload["oauth_url"] == "https://accounts.feishu.cn/device/new"
    assert payload["device_code"] == "device-new"
    assert commands == [
        ("lark-cli auth logout", 10),
        ("lark-cli auth login --no-wait --json --domain all", 20),
    ]
