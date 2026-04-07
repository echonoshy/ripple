"""Skill 执行器

执行 Skill（Inline 和 Fork 模式）。
"""

from typing import Any, Dict

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.messages.utils import create_user_message
from ripple.skills.types import Skill
from ripple.tools.base import ToolResult


async def execute_inline_skill(
    skill: Skill,
    args: str,
    context: ToolUseContext,
    parent_message: AssistantMessage,
) -> ToolResult[Dict[str, Any]]:
    """Inline 模式执行 Skill

    Skill 内容直接注入到当前对话流。

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

    skill_dir = Path(skill.file_path).parent
    content = f"Base directory for this skill: {skill_dir}\n\n{content}"

    # 3. 创建用户消息（meta 消息，对用户不可见）
    user_message = create_user_message(
        content=content,
        is_meta=True,
    )

    # 4. 创建 context 修改器（注入 allowed_tools）
    def context_modifier(ctx: ToolUseContext) -> ToolUseContext:
        if skill.allowed_tools:
            return ctx.with_allowed_tools(skill.allowed_tools)
        return ctx

    # 5. 返回结果
    return ToolResult(
        data={
            "success": True,
            "skill_name": skill.name,
            "status": "inline",
        },
        new_messages=[user_message],
        context_modifier=context_modifier,
    )


async def execute_forked_skill(
    skill: Skill,
    args: str,
    context: ToolUseContext,
    parent_message: AssistantMessage,
) -> ToolResult[Dict[str, Any]]:
    """Fork 模式执行 Skill

    在独立的子代理中执行 Skill。

    Args:
        skill: Skill 对象
        args: 参数字符串
        context: 工具使用上下文
        parent_message: 父助手消息

    Returns:
        工具执行结果
    """
    # TODO: 实现 Fork 模式
    # 需要：
    # 1. 创建新的 agent_id
    # 2. 创建修改后的 ToolUseContext（注入 allowed_tools）
    # 3. 运行子代理循环
    # 4. 收集结果并返回摘要

    # 目前先返回错误
    return ToolResult(
        data={
            "success": False,
            "skill_name": skill.name,
            "status": "fork",
            "error": "Fork mode not implemented yet",
        },
    )
