"""测试 TUI 是否能正常启动和响应"""

import asyncio
from pathlib import Path

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.subagent import SubAgentTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config


async def test_query():
    """测试基本的 query 是否工作"""
    print("🔍 测试 query 函数...")

    config = get_config()
    model = config.get("model.default", "anthropic/claude-3.5-sonnet")

    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SubAgentTool(),
        SkillTool(),
    ]

    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model=model,
        ),
        session_id="test-session",
        cwd=str(Path.cwd()),
    )

    try:
        client = OpenRouterClient()
        print(f"✓ 客户端初始化成功，模型: {model}")
    except ValueError as e:
        print(f"✗ 客户端初始化失败: {e}")
        return

    print("\n📤 发送测试查询: '列出当前目录的文件'")
    print("=" * 60)

    try:
        async for item in query(
            user_input="列出当前目录的文件",
            context=context,
            client=client,
            model=model,
            max_turns=3,
        ):
            if hasattr(item, "type"):
                print(f"\n📦 收到消息类型: {item.type}")

                if item.type == "assistant":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "text":
                                text = block.get("text", "")[:100]
                                print(f"  💬 文本: {text}...")
                            elif block.get("type") == "tool_use":
                                tool_name = block.get("name", "")
                                print(f"  🔧 工具调用: {tool_name}")

                elif item.type == "user":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            is_error = block.get("is_error", False)
                            result = block.get("content", "")[:100]
                            status = "❌ 错误" if is_error else "✓ 成功"
                            print(f"  {status}: {result}...")

        print("\n" + "=" * 60)
        print("✓ 查询完成")

    except Exception as e:
        print(f"\n✗ 查询失败: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_query())
