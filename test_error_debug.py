#!/usr/bin/env python3
"""调试报错"""

import asyncio
from pathlib import Path

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool


async def test_skill_call():
    """测试调用 Skill"""
    # 初始化工具
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SkillTool(),
    ]

    # 创建权限管理器
    permission_manager = PermissionManager(mode=PermissionMode.SMART)

    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model="claude-sonnet-4.6",
        ),
        session_id="test-session",
        cwd=str(Path.cwd()),
        permission_manager=permission_manager,
    )

    # 创建客户端
    client = OpenRouterClient()

    # 第一次查询
    print("=" * 60)
    print("第一次查询：使用 skill 工具")
    print("=" * 60)

    try:
        async for item in query(
            user_input="使用 etf-assistant skill",
            context=context,
            client=client,
            model="claude-sonnet-4.6",
            max_turns=3,
            thinking=False,
        ):
            print(f"Item type: {type(item)}")
            print(f"Has 'type' attr: {hasattr(item, 'type')}")
            if hasattr(item, "type"):
                print(f"item.type = {item.type}")
            else:
                print(f"item = {item}")
            print()

    except Exception as e:
        print(f"错误: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_skill_call())
