"""AskUser 工具 - 让 AI 主动询问用户"""

from typing import Any

from rich.console import Console
from rich.prompt import Prompt

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult


class AskUserTool(Tool):
    """让 AI 主动询问用户获取信息"""

    def __init__(self):
        self.name = "AskUser"
        self.description = """Ask the user for additional information or clarification.

Use this tool when you need:
- User preferences or choices
- Missing information
- Clarification on ambiguous requirements
- Confirmation of your understanding

Input:
- question (required): The question to ask the user
- options (optional): List of options for the user to choose from
"""
        self.risk_level = ToolRiskLevel.SAFE

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "description": "The question to ask the user"},
                        "options": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Optional list of choices for the user",
                        },
                    },
                    "required": ["question"],
                },
            },
        }

    async def call(
        self, args: dict[str, Any], context: ToolUseContext, parent_message: AssistantMessage
    ) -> ToolResult[dict]:
        """执行询问"""
        question = args.get("question", "")
        options = args.get("options", [])

        if context.on_pause_spinner:
            context.on_pause_spinner()

        console = Console()
        console.print(f"\n[bold cyan]🤔 AI 询问:[/bold cyan] {question}\n")

        if options:
            for i, opt in enumerate(options, 1):
                console.print(f"  {i}. {opt}")

            choices = [str(i) for i in range(1, len(options) + 1)]
            answer_idx = Prompt.ask("请选择", choices=choices)
            answer = options[int(answer_idx) - 1]
        else:
            answer = Prompt.ask("请回答")

        console.print(f"[green]✓ 用户回答: {answer}[/green]\n")

        if context.on_resume_spinner:
            context.on_resume_spinner()

        result = {"question": question, "answer": answer, "options": options if options else None}

        return ToolResult(data=result)

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False  # 需要用户交互，不能并发
