"""测试 SubAgentTool

验证子 agent 的基本功能和防递归机制。
"""

import asyncio

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.subagent import SubAgentTool
from ripple.tools.builtin.write import WriteTool


async def test_subagent_basic():
    """测试基本的子 agent 调用"""
    print("\n=== 测试 SubAgentTool 基本功能 ===\n")

    # 初始化工具（包含 SubAgentTool）
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SubAgentTool(),
    ]

    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model="anthropic/claude-3.5-sonnet",
        ),
        session_id="test-session",
        cwd=".",
    )

    # 创建客户端
    try:
        client = OpenRouterClient()
    except ValueError as e:
        print(f"错误: {e}")
        print("请在 config/settings.yaml 中配置 API key")
        return

    # 测试提示：让主 agent 使用 SubAgent 工具
    prompt = """
    请使用 SubAgent 工具来完成以下任务：
    1. 列出当前目录下的所有 Python 文件
    2. 子 agent 只能使用 Bash 工具
    """

    print(f"提示: {prompt}\n")
    print("=" * 60)

    # 执行查询
    try:
        async for item in query(
            user_input=prompt,
            context=context,
            client=client,
            model="anthropic/claude-3.5-sonnet",
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
                                    print(f"\n[Assistant] {text}")
                            elif block.get("type") == "tool_use":
                                tool_name = block.get("name", "")
                                tool_input = block.get("input", {})
                                print(f"\n[Tool Call] {tool_name}")
                                print(f"  Input: {tool_input}")

                elif item.type == "user":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            result_content = block.get("content", "")
                            is_error = block.get("is_error", False)
                            if is_error:
                                print(f"\n[Tool Error] {result_content}")
                            else:
                                print(f"\n[Tool Result] {result_content[:500]}...")

        print("\n" + "=" * 60)
        print("✓ 测试完成")

    except Exception as e:
        print(f"\n错误: {e}")
        import traceback

        traceback.print_exc()


async def test_subagent_no_recursion():
    """测试子 agent 不能再创建子 agent（防递归）"""
    print("\n=== 测试防递归机制 ===\n")

    # 初始化工具
    tools = [
        BashTool(),
        ReadTool(),
        SubAgentTool(),
    ]

    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model="anthropic/claude-3.5-sonnet",
        ),
        session_id="test-no-recursion",
        cwd=".",
    )

    try:
        client = OpenRouterClient()
    except ValueError as e:
        print(f"错误: {e}")
        return

    # 测试：让主 agent 创建子 agent，子 agent 应该无法再创建子 agent
    prompt = """
    使用 SubAgent 工具，让子 agent 尝试再次调用 SubAgent 工具。
    这应该会失败，因为子 agent 的工具列表中不包含 SubAgent。
    """

    print(f"提示: {prompt}\n")
    print("=" * 60)

    try:
        async for item in query(
            user_input=prompt,
            context=context,
            client=client,
            model="anthropic/claude-3.5-sonnet",
            max_turns=3,
        ):
            if hasattr(item, "type"):
                if item.type == "assistant":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "tool_use":
                                tool_name = block.get("name", "")
                                print(f"\n[Tool Call] {tool_name}")

        print("\n" + "=" * 60)
        print("✓ 防递归测试完成")

    except Exception as e:
        print(f"\n错误: {e}")


if __name__ == "__main__":
    print("SubAgentTool 测试套件")
    print("=" * 60)

    # 运行测试
    asyncio.run(test_subagent_basic())
    # asyncio.run(test_subagent_no_recursion())  # 可选：测试防递归
