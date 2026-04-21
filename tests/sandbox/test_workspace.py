"""workspace.py 的 uid 维度 API"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import (
    create_user_workspace,
    destroy_user_sandbox,
    user_sandbox_exists,
)


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_create_and_destroy_user_workspace(tmp_path: Path):
    c = _cfg(tmp_path)
    assert user_sandbox_exists(c, "alice") is False

    ws = create_user_workspace(c, "alice")
    assert ws == c.workspace_dir_by_uid("alice")
    assert ws.exists()
    assert user_sandbox_exists(c, "alice") is True

    destroyed = destroy_user_sandbox(c, "alice")
    assert destroyed is True
    assert user_sandbox_exists(c, "alice") is False


def test_destroy_missing_user_returns_false(tmp_path: Path):
    c = _cfg(tmp_path)
    assert destroy_user_sandbox(c, "ghost") is False


def test_create_user_workspace_idempotent(tmp_path: Path):
    c = _cfg(tmp_path)
    ws1 = create_user_workspace(c, "alice")
    ws2 = create_user_workspace(c, "alice")
    assert ws1 == ws2
    assert ws1.exists()
