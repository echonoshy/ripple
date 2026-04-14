import pytest

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.tools.base import StopReason
from ripple.tools.builtin.bash import BashTool
from ripple.tools.orchestration import execute_tool


@pytest.mark.asyncio
async def test_execute_tool_pauses_with_permission_request_metadata():
    tool = BashTool()
    permission_manager = PermissionManager(mode=PermissionMode.SERVER_SMART)
    context = ToolUseContext(
        options=ToolOptions(tools=[tool], model="sonnet"),
        session_id="test-session",
        permission_manager=permission_manager,
        is_server_mode=True,
    )

    updates = [
        update
        async for update in execute_tool(
            {"id": "toolu_1", "name": "Bash", "input": {"command": "git push"}}, None, context
        )
    ]

    assert len(updates) == 1
    update = updates[0]
    assert update.stop_agent_loop is True
    assert update.stop_reason == StopReason.PERMISSION_REQUEST
    assert update.stop_metadata == {
        "tool": "Bash",
        "params": {"command": "git push"},
        "riskLevel": "dangerous",
    }
    assert update.message is not None
    assert "Awaiting user permission" in update.message.message["content"][0]["content"]


@pytest.mark.asyncio
async def test_permission_manager_supports_once_and_session_grants():
    tool = BashTool()
    permission_manager = PermissionManager(mode=PermissionMode.SERVER_SMART)
    params = {"command": "git push"}

    allowed, _, metadata = await permission_manager.check_permission(tool, params, None)
    assert allowed is False
    assert metadata == {
        "tool": "Bash",
        "params": {"command": "git push"},
        "riskLevel": "dangerous",
    }

    permission_manager.grant_permission(tool, params, scope="once")
    allowed_once, _, _ = await permission_manager.check_permission(tool, params, None)
    assert allowed_once is True
    allowed_after_once, _, _ = await permission_manager.check_permission(tool, params, None)
    assert allowed_after_once is False

    permission_manager.grant_permission(tool, params, scope="session")
    allowed_session_first, _, _ = await permission_manager.check_permission(tool, params, None)
    allowed_session_second, _, _ = await permission_manager.check_permission(tool, params, None)
    assert allowed_session_first is True
    assert allowed_session_second is True


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
