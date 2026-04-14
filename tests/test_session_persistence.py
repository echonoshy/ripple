from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.sandbox.storage import load_session_state
from ripple.tools.base import StopReason


def test_sandbox_manager_suspend_persists_extended_session_fields(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes")
    session_id = "srv-persist-test"
    workspace_dir = config.workspace_dir(session_id)
    workspace_dir.mkdir(parents=True, exist_ok=True)

    manager = object.__new__(SandboxManager)
    manager.config = config

    monkeypatch.setattr("ripple.sandbox.manager.workspace_exists", lambda *_args, **_kwargs: True)

    ok = manager.suspend_session(
        session_id,
        messages=[],
        model="sonnet",
        system_prompt="test prompt",
        max_turns=10,
        status="awaiting_permission",
        pending_question="要继续执行危险命令吗？",
        pending_options=["继续", "取消"],
        pending_permission_request={
            "tool": "Bash",
            "params": {"command": "git push"},
            "riskLevel": "dangerous",
            "stopReason": StopReason.PERMISSION_REQUEST,
        },
    )

    assert ok is True

    state = load_session_state(config, session_id)
    assert state is not None
    assert state["status"] == "awaiting_permission"
    assert state["pending_question"] == "要继续执行危险命令吗？"
    assert state["pending_options"] == ["继续", "取消"]
    assert state["pending_permission_request"]["tool"] == "Bash"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
