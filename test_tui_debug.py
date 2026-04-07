"""调试 TUI 重复显示问题"""

import asyncio
from pathlib import Path

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool


async def test_query():
    """测试查询流程"""
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SkillTool(),
    ]

    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model="claude-sonnet-4.6",
        ),
        session_id="debug-session",
        cwd=str(Path.cwd()),
    )

    client = OpenRouterClient()

    user_input = "帮我看下当前目录有哪些文件"

    print("=== 开始测试 ===\n")
    print(f"用户输入: {user_input}\n")

    assistant_message_count = 0
    tool_use_count = 0

    async for item in query(
        user_input=user_input,
        context=context,
        client=client,
        model="claude-sonnet-4.6",
        max_turns=10,
    ):
        if hasattr(item, "type"):
            if item.type == "assistant":
                assistant_message_count += 1
                print(f"\n[Assistant Message #{assistant_message_count}]")
                content = item.message.get("content", [])
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            text = block.get("text", "")
                            if text.strip():
                                print(f"  Text: {text[:50]}...")
                        elif block.get("type") == "tool_use":
                            tool_use_count += 1
                            tool_name = block.get("name", "")
                            tool_id = block.get("id", "")
                            print(f"  Tool Use #{tool_use_count}: {tool_name} (ID: {tool_id})")

            elif item.type == "user":
                print(f"\n[User Message - Tool Result]")
                content = item.message.get("content", [])
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        tool_use_id = block.get("tool_use_id", "")
                        is_error = block.get("is_error", False)
                        print(f"  Tool Result for ID: {tool_use_id}, Error: {is_error}")

    print(f"\n=== 测试完成 ===")
    print(f"总共收到 {assistant_message_count} 个 Assistant Message")
    print(f"总共收到 {tool_use_count} 个 Tool Use")


if __name__ == "__main__":
    asyncio.run(test_query())
