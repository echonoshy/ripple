"""SandboxManager user 维度 API"""

from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


def _manager(tmp_path: Path) -> SandboxManager:
    from ripple.sandbox import manager as mgr

    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]
    return SandboxManager(cfg)


def test_ensure_sandbox_creates_layout(tmp_path: Path):
    m = _manager(tmp_path)
    workspace = m.ensure_sandbox("alice")
    assert workspace == m.config.workspace_dir("alice")
    assert workspace.exists()
    assert (m.config.sandbox_dir("alice") / "credentials").exists()
    assert (m.config.sandbox_dir("alice") / "sessions").exists()


def test_ensure_sandbox_idempotent(tmp_path: Path):
    m = _manager(tmp_path)
    ws1 = m.ensure_sandbox("alice")
    ws2 = m.ensure_sandbox("alice")
    assert ws1 == ws2


def test_teardown_sandbox(tmp_path: Path):
    m = _manager(tmp_path)
    m.ensure_sandbox("alice")
    assert m.teardown_sandbox("alice") is True
    assert not m.config.sandbox_dir("alice").exists()
    assert m.teardown_sandbox("alice") is False


def test_teardown_sandbox_rejects_default(tmp_path: Path):
    m = _manager(tmp_path)
    m.ensure_sandbox("default")
    with pytest.raises(PermissionError, match="default"):
        m.teardown_sandbox("default", allow_default=False)


def test_setup_session_creates_session_dir(tmp_path: Path):
    m = _manager(tmp_path)
    m.setup_session("alice", "srv-abc")
    assert m.config.session_dir("alice", "srv-abc").exists()


def test_teardown_session_removes_session_only(tmp_path: Path):
    m = _manager(tmp_path)
    m.setup_session("alice", "srv-abc")
    m.setup_session("alice", "srv-def")
    m.teardown_session("alice", "srv-abc")
    assert not m.config.session_dir("alice", "srv-abc").exists()
    assert m.config.session_dir("alice", "srv-def").exists()
    assert m.config.sandbox_dir("alice").exists()
