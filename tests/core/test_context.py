"""ToolUseContext 新增 user_id 字段"""

from pathlib import Path

from ripple.core.context import ToolOptions, ToolUseContext


def test_user_id_default_none():
    ctx = ToolUseContext(options=ToolOptions(), session_id="sid")
    assert ctx.user_id is None


def test_user_id_assignment():
    ctx = ToolUseContext(options=ToolOptions(), session_id="sid", user_id="alice")
    assert ctx.user_id == "alice"


def test_is_sandboxed_requires_user_id(tmp_path: Path):
    ws = tmp_path / "sandboxes" / "alice" / "workspace"
    ws.mkdir(parents=True)

    ctx = ToolUseContext(
        options=ToolOptions(),
        session_id="sid",
        workspace_root=ws,
        sandbox_session_id="srv-abc",
        user_id="alice",
    )
    assert ctx.user_id == "alice"
