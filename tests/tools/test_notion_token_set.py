"""NotionTokenSet 写入 user 级 credentials/notion.json"""

import json
from pathlib import Path

import pytest

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import create_sandbox
from ripple.tools.builtin import bash as bash_mod
from ripple.tools.builtin.notion_token_set import NotionTokenSetTool


@pytest.mark.asyncio
async def test_notion_token_set_writes_to_user_dir(tmp_path: Path):
    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    create_sandbox(cfg, "alice")
    bash_mod._sandbox_config = cfg  # type: ignore[assignment]

    ctx = ToolUseContext(
        options=ToolOptions(),
        session_id="int",
        workspace_root=cfg.workspace_dir("alice"),
        sandbox_session_id="srv-abc",
        user_id="alice",
    )
    tool = NotionTokenSetTool()
    token = "ntn_" + "x" * 30
    result = await tool.call({"api_token": token}, ctx, None)

    assert result.data["ok"] is True
    assert token not in json.dumps(result.data)
    notion_file = cfg.notion_config_file("alice")
    assert notion_file.exists()
    data = json.loads(notion_file.read_text())
    assert data["api_token"] == token


@pytest.mark.asyncio
async def test_notion_token_set_requires_user_id(tmp_path: Path):
    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    bash_mod._sandbox_config = cfg  # type: ignore[assignment]

    ctx = ToolUseContext(
        options=ToolOptions(),
        session_id="int",
        sandbox_session_id="srv-abc",
    )
    tool = NotionTokenSetTool()
    result = await tool.call({"api_token": "ntn_" + "x" * 30}, ctx, None)

    assert result.data["ok"] is False
    assert "user_id" in result.data["error"]


@pytest.mark.asyncio
async def test_notion_token_set_rejects_bad_prefix(tmp_path: Path):
    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    bash_mod._sandbox_config = cfg  # type: ignore[assignment]

    ctx = ToolUseContext(
        options=ToolOptions(),
        session_id="int",
        user_id="alice",
    )
    tool = NotionTokenSetTool()
    result = await tool.call({"api_token": "wrong_prefix_xxxxxxxxxx"}, ctx, None)
    assert result.data["ok"] is False
