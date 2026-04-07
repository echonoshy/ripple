"""基础测试 - 验证 Agent Loop 能否运行"""

import asyncio
from pathlib import Path

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool


async def test_basic():
    """测试基础功能"""
    print("🧪 测试 Ripple Agent Loop\n")

    # 初始化工具
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
    ]

    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model="anthropic/claude-3.5-sonnet",
        ),
        session_id="test-session",
        cwd=str(Path.cwd()),
    )

    # 创建客户端
    try:
        client = OpenRouterClient()
    except ValueError as e:
        print(f"❌ 错误: {e}")
        print("请设置 OPENROUTER_API_KEY 环境变量")
        return

    # 简单的测试提示
    prompt = "创建一个文件 /tmp/ripple_test.txt，内容是 'Hello from Ripple!'"

    print(f"📝 提示: {prompt}\n")
    print("=" * 60)

    # 执行查询
    try:
        async for item in query(
            user_input=prompt,
            context=context,
            client=client,
            max_turns=5,
        ):
            if hasattr(item, "type"):
                if item.type == "assistant":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "text":
                                text = block.get("text", "")
                                if text.strip():
                                    print(f"💬 助手: {text[:200]}...")
                            elif block.get("type") == "tool_use":
                                tool_name = block.get("name", "")
                                print(f"🔧 调用工具: {tool_name}")

                elif item.type == "user":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            is_error = block.get("is_error", False)
                            if is_error:
                                print("❌ 工具错误")
                            else:
                                print("✓ 工具执行成功")

        print("\n" + "=" * 60)
        print("✅ 测试完成！")

        # 验证文件是否创建
        test_file = Path("/tmp/ripple_test.txt")
        if test_file.exists():
            content = test_file.read_text()
            print(f"✓ 文件已创建: {test_file}")
            print(f"✓ 文件内容: {content}")
        else:
            print("⚠️  文件未创建")

    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_basic())
