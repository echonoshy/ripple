"""Skill 执行器

执行 Skill（Inline 和 Fork 模式）。
"""

from pathlib import Path
from typing import Any

from ripple.agent_runners.manager import get_external_agent_manager
from ripple.agent_runners.service import start_agent_run
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
    parent_message: AssistantMessage | None,
) -> ToolResult[dict[str, Any]]:
    """Run a fork-mode skill through the trusted Codex AgentRunner."""
    content = skill.substitute_arguments(args)

    skill_dir = _get_skill_dir(skill)
    if skill_dir:
        content = f"Base directory for this skill: {skill_dir}\n\n{content}"

    workspace_root = context.workspace_root or context.cwd
    runtime_dir = context.session_runtime_dir or (context.cwd / ".ripple")
    sandbox_config = context.sandbox_manager.config if context.is_sandboxed and context.sandbox_manager else None
    try:
        job = start_agent_run(
            prompt=content,
            provider_name="codex",
            raw_cwd=None,
            max_runtime_seconds=1800,
            user_id=context.user_id,
            session_id=context.session_id,
            workspace_root=workspace_root,
            runtime_dir=runtime_dir,
            manager=get_external_agent_manager(),
            sandbox_config=sandbox_config,
            require_agent_route=False,
        )
        return ToolResult(
            data={
                "success": True,
                "skill_name": skill.name,
                "status": "agent_runner",
                "job_id": job.job_id,
                "provider": job.provider,
                "output_file": str(job.output_file) if job.output_file else None,
                "events_file": str(job.events_file) if job.events_file else None,
            },
        )
    except Exception as exc:  # noqa: BLE001
        return ToolResult(
            data={
                "success": False,
                "skill_name": skill.name,
                "status": "agent_runner",
                "error": str(exc),
            },
        )
