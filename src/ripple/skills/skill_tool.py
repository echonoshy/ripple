"""Skill Tool

作为工具暴露给模型，让模型可以调用 Skill。
"""

from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.skills.executor import execute_forked_skill, execute_inline_skill
from ripple.skills.loader import get_global_loader, reload_skills
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

        reload_skills()
        loader = get_global_loader()
        skill = loader.get_skill(skill_name)

        if not skill:
            return ToolResult(
                data={
                    "success": False,
                    "error": f"Skill '{skill_name}' not found",
                    "available_skills": [s.name for s in loader.list_skills()],
                }
            )

        if skill.context == "fork":
            return await execute_forked_skill(skill, args.args, context, parent_message)
        else:
            return await execute_inline_skill(skill, args.args, context, parent_message)

    def is_concurrency_safe(self, input: SkillInput | dict[str, Any]) -> bool:
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        reload_skills()
        loader = get_global_loader()
        available_skills = [s.name for s in loader.list_skills()]

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
