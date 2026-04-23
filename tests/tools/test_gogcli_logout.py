"""Tests for GoogleWorkspaceLogout tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ripple.core.context import ToolUseContext
from ripple.tools.builtin.gogcli_logout import GoogleWorkspaceLogoutTool


def _ctx(user_id: str = "alice") -> ToolUseContext:
    ctx = MagicMock(spec=ToolUseContext)
    ctx.user_id = user_id
    return ctx


@pytest.mark.asyncio
async def test_rejects_missing_email():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    with patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg):
        res = await tool.call({"email": ""}, _ctx(), None)
    assert res.data["ok"] is False
    assert "email" in res.data["error"]


@pytest.mark.asyncio
async def test_rejects_invalid_email():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    with patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg):
        res = await tool.call({"email": "not-an-email"}, _ctx(), None)
    assert res.data["ok"] is False


@pytest.mark.asyncio
async def test_success_path():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"

    call_count = {"n": 0}

    async def fake_exec(cmd, *a, **kw):
        call_count["n"] += 1
        if "auth remove" in cmd:
            assert "'alice@gmail.com'" in cmd
            assert "--force" in cmd
            return ("removed", "", 0)
        if "auth list" in cmd:
            return ('{"accounts":[{"email":"bob@x.com"}]}', "", 0)
        raise AssertionError(f"unexpected cmd: {cmd}")

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch("ripple.tools.builtin.gogcli_logout.execute_in_sandbox", new=fake_exec),
    ):
        res = await tool.call({"email": "alice@gmail.com"}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["email"] == "alice@gmail.com"
    assert res.data["remaining_accounts"] == 1
    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_remove_fails_when_email_not_bound():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_logout.execute_in_sandbox",
            new=AsyncMock(return_value=("", "account not found", 2)),
        ),
    ):
        res = await tool.call({"email": "nobody@x.com"}, _ctx(), None)

    assert res.data["ok"] is False
    assert "not found" in res.data["error"]


@pytest.mark.asyncio
async def test_success_even_if_list_fails_after():
    """auth remove 成功，但 auth list 验证失败时仍算整体成功（主操作已完成）。"""
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"

    async def fake_exec(cmd, *a, **kw):
        if "auth remove" in cmd:
            return ("removed", "", 0)
        return ("", "keyring lock contention", 1)

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch("ripple.tools.builtin.gogcli_logout.execute_in_sandbox", new=fake_exec),
    ):
        res = await tool.call({"email": "alice@gmail.com"}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["remaining_accounts"] is None
