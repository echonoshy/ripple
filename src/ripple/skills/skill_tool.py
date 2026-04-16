"""Skill Tool

作为工具暴露给模型，让模型可以调用 Skill。

Server 模式下每个 session 拥有独立的 skill 集合（bundled + shared + workspace/skills/），
CLI 模式下使用全局 SkillLoader。
"""

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.skills.executor import execute_forked_skill, execute_inline_skill
from ripple.skills.loader import get_global_loader, load_shared_skills, load_workspace_skills, reload_skills
from ripple.skills.types import Skill
from ripple.tools.base import Tool, ToolResult


class SkillInput(BaseModel):
    """Skill Tool 输入"""

    skill: str = Field(description="Skill 名称（例如：commit, review-pr）")
    args: str = Field(default="", description="可选参数")


class SkillTool(Tool[SkillInput, dict[str, Any]]):
    """Skill Tool

    执行用户定义的 Skill。
    """

    def __init__(self):
        self.name = "Skill"
        self.description = (
            "Execute a specialized skill to extend your capabilities. "
            "Skills are pre-defined task templates for domain-specific tasks. "
            "Check available skills in the parameter schema before declining user requests."
        )
        self.max_result_size_chars = 100_000

    def _get_skills(self, workspace_root: Path | None) -> dict[str, Skill]:
        """获取当前可用的 skill 集合

        Server 模式：使用 workspace 级别加载（bundled + shared + workspace/skills/）
        CLI 模式：使用全局 loader（bundled + CWD/skills/）
        """
        if workspace_root:
            return load_workspace_skills(workspace_root)
        reload_skills()
        loader = get_global_loader()
        return {s.name: s for s in loader.list_skills()}

    async def call(
        self,
        args: SkillInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict[str, Any]]:
        """执行 Skill"""
        if isinstance(args, dict):
            args = SkillInput(**args)

        skill_name = args.skill.lstrip("/")

        skills = self._get_skills(context.workspace_root)
        skill = skills.get(skill_name)

        if not skill:
            return ToolResult(
                data={
                    "success": False,
                    "error": f"Skill '{skill_name}' not found",
                    "available_skills": list(skills.keys()),
                }
            )

        if skill.context == "fork":
            return await execute_forked_skill(skill, args.args, context, parent_message)
        else:
            return await execute_inline_skill(skill, args.args, context, parent_message)

    def is_concurrency_safe(self, input: SkillInput | dict[str, Any]) -> bool:
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        available_skills = list(load_shared_skills().keys())

        description = "The skill name"
        if available_skills:
            description += f". Available: {', '.join(available_skills[:10])}"
            if len(available_skills) > 10:
                description += f" and {len(available_skills) - 10} more"

        return {
            "type": "object",
            "properties": {
                "skill": {
                    "type": "string",
                    "description": description,
                },
                "args": {
                    "type": "string",
                    "description": "Optional arguments for the skill",
                    "default": "",
                },
            },
            "required": ["skill"],
        }
