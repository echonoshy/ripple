"""Skill 执行器

执行 Skill（Inline 和 Fork 模式）。
"""

from pathlib import Path
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.skills.types import Skill
from ripple.tools.base import ToolResult


def _get_skill_dir(skill: Skill) -> Path | None:
    """获取 skill 的基目录，bundled skill 返回 None"""
    if skill.file_path.startswith("<bundled:"):
        return None
    return Path(skill.file_path).parent


async def execute_inline_skill(
    skill: Skill,
    args: str,
    context: ToolUseContext,
    parent_message: AssistantMessage,
) -> ToolResult[dict[str, Any]]:
    """Inline 模式执行 Skill

    Skill 内容直接通过工具返回值注入到对话流，模型在 tool_result 中看到 skill 指令。
    """
    content = skill.substitute_arguments(args)

    skill_dir = _get_skill_dir(skill)
    if skill_dir:
        content = f"Base directory for this skill: {skill_dir}\n\n{content}"

    def context_modifier(ctx: ToolUseContext) -> ToolUseContext:
        if skill.is_all_tools_allowed:
            return ctx
        if skill.allowed_tools:
            return ctx.with_allowed_tools(skill.allowed_tools)
        return ctx

    return ToolResult(
        data=content,
        context_modifier=context_modifier,
    )


async def execute_forked_skill(
    skill: Skill,
    args: str,
    context: ToolUseContext,
    parent_message: AssistantMessage,
) -> ToolResult[dict[str, Any]]:
    """Fork 模式执行 Skill

    在独立的子代理中执行 Skill，通过 Agent tool 实现。
    """
    content = skill.substitute_arguments(args)

    skill_dir = _get_skill_dir(skill)
    if skill_dir:
        content = f"Base directory for this skill: {skill_dir}\n\n{content}"

    from ripple.tools.builtin.agent_tool import AgentTool, AgentToolInput

    agent_tool = AgentTool()

    agent_input = AgentToolInput(
        description=f"Running skill: {skill.name}",
        prompt=content,
        run_in_background=True,
    )

    if skill.is_all_tools_allowed:
        fork_context = context
    elif skill.allowed_tools:
        fork_context = context.with_allowed_tools(skill.allowed_tools)
    else:
        fork_context = context

    result = await agent_tool.call(agent_input, fork_context, parent_message)

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
