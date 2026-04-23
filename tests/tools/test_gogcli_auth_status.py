"""Tests for GoogleWorkspaceAuthStatus tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ripple.core.context import ToolUseContext
from ripple.tools.builtin.gogcli_auth_status import GoogleWorkspaceAuthStatusTool


def _ctx(user_id: str = "alice") -> ToolUseContext:
    ctx = MagicMock(spec=ToolUseContext)
    ctx.user_id = user_id
    return ctx


@pytest.mark.asyncio
async def test_returns_error_when_sandbox_disabled():
    tool = GoogleWorkspaceAuthStatusTool()
    with patch("ripple.tools.builtin.bash._sandbox_config", None):
        res = await tool.call({}, _ctx(), None)
    assert res.data["ok"] is False
    assert "Sandbox" in res.data["error"]


@pytest.mark.asyncio
async def test_returns_error_when_no_user_id():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    with patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg):
        res = await tool.call({}, _ctx(user_id=""), None)
    assert res.data["ok"] is False
    assert "user_id" in res.data["error"]


@pytest.mark.asyncio
async def test_returns_empty_list_when_no_accounts_bound():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=('{"accounts":[]}', "", 0)),
        ),
    ):
        res = await tool.call({}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["accounts"] == []
    assert res.data["count"] == 0
    assert res.data["has_client_config"] is True
    assert res.data["checked"] is False


@pytest.mark.asyncio
async def test_returns_accounts_when_bound():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    stdout = (
        '{"accounts":[{"email":"a@x.com","alias":"work","valid":true},{"email":"b@y.com","alias":null,"valid":false}]}'
    )
    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=(stdout, "", 0)),
        ),
    ):
        res = await tool.call({"check": True}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["count"] == 2
    assert res.data["accounts"][0]["email"] == "a@x.com"
    assert res.data["accounts"][0]["valid"] is True
    assert res.data["accounts"][1]["valid"] is False
    assert res.data["checked"] is True


@pytest.mark.asyncio
async def test_passes_check_flag_to_gog():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    captured: dict = {}

    async def fake_exec(cmd, *a, **kw):
        captured["cmd"] = cmd
        return ('{"accounts":[]}', "", 0)

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch("ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox", new=fake_exec),
    ):
        await tool.call({"check": True}, _ctx(), None)
    assert "--check" in captured["cmd"]

    captured.clear()
    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch("ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox", new=fake_exec),
    ):
        await tool.call({}, _ctx(), None)
    assert "--check" not in captured["cmd"]


@pytest.mark.asyncio
async def test_returns_error_when_gog_fails():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=("", "keyring locked", 1)),
        ),
    ):
        res = await tool.call({}, _ctx(), None)
    assert res.data["ok"] is False
    assert "keyring locked" in res.data["error"]


@pytest.mark.asyncio
async def test_reports_no_client_config_warning():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = False

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=('{"accounts":[]}', "", 0)),
        ),
    ):
        res = await tool.call({}, _ctx(), None)
    assert res.data["ok"] is True
    assert res.data["has_client_config"] is False
