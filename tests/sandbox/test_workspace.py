"""workspace.py 的 user 维度 API"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import (
    create_sandbox,
    destroy_sandbox,
    sandbox_exists,
)


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_create_and_destroy_sandbox(tmp_path: Path):
    c = _cfg(tmp_path)
    assert sandbox_exists(c, "alice") is False

    ws = create_sandbox(c, "alice")
    assert ws == c.workspace_dir("alice")
    assert ws.exists()
    assert sandbox_exists(c, "alice") is True

    destroyed = destroy_sandbox(c, "alice")
    assert destroyed is True
    assert sandbox_exists(c, "alice") is False


def test_destroy_missing_user_returns_false(tmp_path: Path):
    c = _cfg(tmp_path)
    assert destroy_sandbox(c, "ghost") is False


def test_create_sandbox_idempotent(tmp_path: Path):
    c = _cfg(tmp_path)
    ws1 = create_sandbox(c, "alice")
    ws2 = create_sandbox(c, "alice")
    assert ws1 == ws2
    assert ws1.exists()
