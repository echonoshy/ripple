"""按 (uid, sid) 维度持久化 session 状态"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.storage import (
    delete_session_state,
    get_suspended_session_info,
    load_session_state,
    save_session_state,
)
from ripple.sandbox.workspace import create_sandbox


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_save_and_load_roundtrip(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")

    save_session_state(
        c,
        "alice",
        "srv-001",
        messages=[],
        model="sonnet",
        caller_system_prompt=None,
        max_turns=10,
    )

    state = load_session_state(c, "alice", "srv-001")
    assert state is not None
    assert state["model"] == "sonnet"
    assert state["messages"] == []


def test_load_missing_returns_none(tmp_path: Path):
    c = _cfg(tmp_path)
    assert load_session_state(c, "alice", "srv-none") is None


def test_delete_session_state(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")
    save_session_state(
        c,
        "alice",
        "srv-002",
        messages=[],
        model="sonnet",
        caller_system_prompt=None,
        max_turns=10,
    )

    assert delete_session_state(c, "alice", "srv-002") is True
    assert load_session_state(c, "alice", "srv-002") is None


def test_get_suspended_info(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")
    save_session_state(
        c,
        "alice",
        "srv-003",
        messages=[],
        model="sonnet",
        caller_system_prompt=None,
        max_turns=10,
    )

    info = get_suspended_session_info(c, "alice", "srv-003")
    assert info is not None
    assert info["session_id"] == "srv-003"
    assert info["model"] == "sonnet"
