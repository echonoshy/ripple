"""AskUser 工具 - 让 AI 主动询问用户

将问题通过 stop_agent_loop 挂起 agent，由前端 UI 呈现给用户，
用户回复后再由 `/v1/sessions/{id}/resume` 等恢复流程继续。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import StopReason, Tool, ToolResult


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
        """将问题挂起到前端交互"""
        question = args.get("question", "")
        options = args.get("options", [])

        hint = f"The question has been displayed to the user via the chat interface. Question: '{question}'. "
        if options:
            hint += f"Options presented: {options}. "
        hint += "The agent loop has been paused. The user's response will be provided in the next message."
        return ToolResult(
            data={"question": question, "answer": hint, "options": options or None},
            stop_agent_loop=True,
            stop_reason=StopReason.ASK_USER,
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
