"""SandboxConfig 新增 user 维度路径方法"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_sandbox_dir(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.sandbox_dir("alice") == tmp_path / "sandboxes" / "alice"


def test_workspace_dir_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.workspace_dir_by_uid("alice") == tmp_path / "sandboxes" / "alice" / "workspace"


def test_session_dir_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.session_dir_by_uid("alice", "srv-abc") == (tmp_path / "sandboxes" / "alice" / "sessions" / "srv-abc")


def test_credential_paths(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.feishu_config_file_by_uid("alice") == (tmp_path / "sandboxes" / "alice" / "credentials" / "feishu.json")
    assert c.notion_config_file_by_uid("alice") == (tmp_path / "sandboxes" / "alice" / "credentials" / "notion.json")


def test_nsjail_cfg_file_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.nsjail_cfg_file_by_uid("alice") == tmp_path / "sandboxes" / "alice" / "nsjail.cfg"


def test_per_session_runtime_files(tmp_path: Path):
    c = _cfg(tmp_path)
    base = tmp_path / "sandboxes" / "alice" / "sessions" / "srv-abc"
    assert c.meta_file_by_uid("alice", "srv-abc") == base / "meta.json"
    assert c.messages_file_by_uid("alice", "srv-abc") == base / "messages.jsonl"
    assert c.tasks_file_by_uid("alice", "srv-abc") == base / "tasks.json"
    assert c.task_outputs_dir_by_uid("alice", "srv-abc") == base / "task-outputs"


def test_user_id_validated(tmp_path: Path):
    import pytest

    c = _cfg(tmp_path)
    with pytest.raises(ValueError):
        c.sandbox_dir("../evil")


def test_has_python_venv_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.has_python_venv_by_uid("alice") is False

    venv_cfg = c.workspace_dir_by_uid("alice") / ".venv" / "pyvenv.cfg"
    venv_cfg.parent.mkdir(parents=True)
    venv_cfg.write_text("")
    assert c.has_python_venv_by_uid("alice") is True


def test_has_pnpm_setup_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    marker = c.workspace_dir_by_uid("alice") / ".local" / ".node-setup-done"
    marker.parent.mkdir(parents=True)
    marker.touch()
    assert c.has_pnpm_setup_by_uid("alice") is True


def test_has_lark_cli_config_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    cfg = c.workspace_dir_by_uid("alice") / ".lark-cli" / "config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text("{}")
    assert c.has_lark_cli_config_by_uid("alice") is True


def test_has_notion_token_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.has_notion_token_by_uid("alice") is False

    f = c.notion_config_file_by_uid("alice")
    f.parent.mkdir(parents=True)
    f.write_text('{"api_token": "ntn_abc123def456ghi789"}')
    assert c.has_notion_token_by_uid("alice") is True
