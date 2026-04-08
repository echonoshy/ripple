"""Skill Tool

作为工具暴露给模型，让模型可以调用 Skill。
"""

from typing import Any, Dict

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


class SkillTool(Tool[SkillInput, Dict[str, Any]]):
    """Skill Tool

    执行用户定义的 Skill。
    """

    def __init__(self):
        self.name = "Skill"
        self.description = """Execute a specialized skill to extend your capabilities beyond software development.

Skills are pre-defined task templates that allow you to handle requests outside your core expertise.

IMPORTANT: Before declining a user request because it's outside your domain (e.g., finance, fortune-telling, etc.),
check if there's a relevant skill available by calling this tool.

Available skills are listed in the tool's parameter schema. Common skills include:
- etf-assistant: ETF investment analysis and recommendations
- fortune-master-ultimate: Chinese fortune-telling and astrology
- web-search: Web search and summarization
- And more...

When to use:
1. User asks about topics outside software development (finance, divination, etc.)
2. User explicitly mentions a skill name (e.g., "use etf-assistant")
3. You need specialized domain knowledge

Usage: Call this tool with the skill name and optional arguments."""
        self.max_result_size_chars = 100_000

    async def call(
        self,
        args: SkillInput | Dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[Dict[str, Any]]:
        """执行 Skill

        Args:
            args: Skill 参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            执行结果
        """
        # 解析输入
        if isinstance(args, dict):
            args = SkillInput(**args)

        # 移除前导斜杠（兼容性）
        skill_name = args.skill.lstrip("/")

        # 重新加载 skills 以确保使用磁盘上的最新版本
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

        # 根据执行上下文选择执行模式
        if skill.context == "fork":
            return await execute_forked_skill(skill, args.args, context, parent_message)
        else:
            return await execute_inline_skill(skill, args.args, context, parent_message)

    def is_concurrency_safe(self, input: SkillInput | Dict[str, Any]) -> bool:
        """Skill 执行不是并发安全的

        Args:
            input: 输入参数

        Returns:
            False
        """
        return False

    def _get_parameters_schema(self) -> Dict[str, Any]:
        """获取参数 schema

        Returns:
            JSON Schema
        """
        # 重新加载并动态生成可用 Skill 列表
        reload_skills()
        loader = get_global_loader()
        available_skills = [s.name for s in loader.list_skills()]

        description = "The skill name (e.g., 'commit', 'review-pr')"
        if available_skills:
            description += f". Available skills: {', '.join(available_skills[:10])}"
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
