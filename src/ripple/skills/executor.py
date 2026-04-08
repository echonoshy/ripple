"""Skill 执行器

执行 Skill（Inline 和 Fork 模式）。
"""

from pathlib import Path
from typing import Any, Dict

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.skills.types import Skill
from ripple.tools.base import ToolResult


async def execute_inline_skill(
    skill: Skill,
    args: str,
    context: ToolUseContext,
    parent_message: AssistantMessage,
) -> ToolResult[Dict[str, Any]]:
    """Inline 模式执行 Skill

    Skill 内容直接通过工具返回值注入到对话流，模型在 tool_result 中看到 skill 指令。

    Args:
        skill: Skill 对象
        args: 参数字符串
        context: 工具使用上下文
        parent_message: 父助手消息

    Returns:
        工具执行结果
    """
    content = skill.substitute_arguments(args)

    skill_dir = Path(skill.file_path).parent
    result_content = f"Base directory for this skill: {skill_dir}\n\n{content}"

    def context_modifier(ctx: ToolUseContext) -> ToolUseContext:
        if skill.is_all_tools_allowed:
            return ctx
        if skill.allowed_tools:
            return ctx.with_allowed_tools(skill.allowed_tools)
        return ctx

    return ToolResult(
        data=result_content,
        context_modifier=context_modifier,
    )


async def execute_forked_skill(
    skill: Skill,
    args: str,
    context: ToolUseContext,
    parent_message: AssistantMessage,
) -> ToolResult[Dict[str, Any]]:
    """Fork 模式执行 Skill

    在独立的子代理中执行 Skill，通过 Agent tool 实现。

    Args:
        skill: Skill 对象
        args: 参数字符串
        context: 工具使用上下文
        parent_message: 父助手消息

    Returns:
        工具执行结果
    """
    # 1. 参数替换
    content = skill.substitute_arguments(args)

    # 2. 添加 base directory 信息
    from pathlib import Path

    skill_dir = Path(skill.file_path).parent if not skill.file_path.startswith("<bundled:") else None
    if skill_dir:
        content = f"Base directory for this skill: {skill_dir}\n\n{content}"

    # 3. 使用 Agent tool 启动 fork
    from ripple.tools.builtin.agent_tool import AgentTool, AgentToolInput

    # 注意：AgentTool 需要父 agent 的消息历史，但这里我们在 skill 执行中
    # 暂时传空列表，因为 fork 模式主要用于独立任务
    agent_tool = AgentTool(messages=[])

    agent_input = AgentToolInput(
        description=f"Running skill: {skill.name}",
        prompt=content,
        subagent_type=None,  # Fork 模式：继承完整上下文
        run_in_background=True,
    )

    # 4. 创建修改后的上下文（注入 allowed_tools）
    if skill.is_all_tools_allowed:
        # 允许所有工具，使用原上下文
        fork_context = context
    elif skill.allowed_tools:
        # 仅允许指定工具
        fork_context = context.with_allowed_tools(skill.allowed_tools)
    else:
        # 没有指定工具，使用原上下文
        fork_context = context

    # 5. 执行 Agent tool
    result = await agent_tool.call(agent_input, fork_context, parent_message)

    # 6. 返回结果
    if result.data and hasattr(result.data, "status"):
        return ToolResult(
            data={
                "success": True,
                "skill_name": skill.name,
                "status": "fork",
                "task_id": result.data.task_id,
                "output_file": result.data.output_file,
            },
            new_messages=result.new_messages,
        )
    else:
        return ToolResult(
            data={
                "success": False,
                "skill_name": skill.name,
                "status": "fork",
                "error": "Failed to launch fork agent",
            },
        )
