"""测试 Fork 模式执行

测试通过 Agent tool 执行 fork 模式的 skill。
"""

import asyncio

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.messages.types import AssistantMessage, ToolUseBlock
from ripple.skills.executor import execute_forked_skill
from ripple.skills.loader import get_global_loader


async def test_fork_execution():
    """测试 fork 模式执行"""
    print("测试 Fork 模式执行")
    print("=" * 60)

    # 加载 skill
    loader = get_global_loader()
    hello_skill = loader.get_skill("hello-bundled")

    if not hello_skill:
        print("✗ 找不到 hello-bundled skill")
        return

    # 修改为 fork 模式
    hello_skill.context = "fork"

    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(tools=[], model="anthropic/claude-3.5-sonnet"),
        session_id="test-session",
        cwd=".",
        permission_mode="allow",
    )

    # 创建父消息
    parent_message = AssistantMessage(
        type="assistant",
        message={
            "id": "test-msg-id",
            "content": [
                {"type": "text", "text": "Testing fork mode"},
                {
                    "type": "tool_use",
                    "id": "test-tool-id",
                    "name": "Skill",
                    "input": {"skill": "hello-bundled", "args": "World"},
                },
            ],
        },
    )

    # 执行 fork 模式
    print(f"\n执行 fork 模式 skill: {hello_skill.name}")
    result = await execute_forked_skill(hello_skill, "World", context, parent_message)

    print(f"\n结果:")
    print(f"  Success: {result.data.get('success')}")
    print(f"  Status: {result.data.get('status')}")
    print(f"  Task ID: {result.data.get('task_id')}")
    print(f"  Output File: {result.data.get('output_file')}")

    if result.new_messages:
        print(f"  New Messages: {len(result.new_messages)}")

    print("\n✓ Fork 模式测试完成")


if __name__ == "__main__":
    asyncio.run(test_fork_execution())
