"""测试 Skill 系统"""

import asyncio
from pathlib import Path

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.loader import get_global_loader
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool


async def test_skill_system():
    """测试 Skill 系统"""
    print("🧪 测试 Ripple Skill 系统\n")

    # 加载 Skills
    loader = get_global_loader()
    skills = loader.list_skills()
    print(f"📚 已加载 {len(skills)} 个 Skills:")
    for skill in skills:
        print(f"  - {skill.name}: {skill.description}")
    print()

    # 初始化工具
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SkillTool(),
    ]

    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model="anthropic/claude-3.5-sonnet",
        ),
        session_id="test-skill-session",
        cwd=str(Path.cwd()),
    )

    # 创建客户端
    try:
        client = OpenRouterClient()
    except ValueError as e:
        print(f"❌ 错误: {e}")
        print("请设置 OPENROUTER_API_KEY 环境变量")
        return

    # 测试提示：使用 hello skill
    prompt = "使用 hello skill 向 'World' 打招呼"

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
                                    print(f"💬 助手: {text[:300]}")
                            elif block.get("type") == "tool_use":
                                tool_name = block.get("name", "")
                                tool_input = block.get("input", {})
                                print(f"🔧 调用工具: {tool_name}")
                                if tool_name == "Skill":
                                    print(f"   Skill: {tool_input.get('skill', '')}")
                                    print(f"   Args: {tool_input.get('args', '')}")

                elif item.type == "user":
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            result_content = block.get("content", "")
                            is_error = block.get("is_error", False)
                            if is_error:
                                print(f"❌ 工具错误: {result_content[:200]}")
                            else:
                                print("✓ 工具执行成功")
                                if len(result_content) < 200:
                                    print(f"   结果: {result_content}")

        print("\n" + "=" * 60)
        print("✅ 测试完成！")

    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_skill_system())
