"""Agent 工具

Fork 模式：继承父 agent 的完整对话上下文，后台运行子 agent。
"""

from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from ripple.core.background import create_task_notification, get_task_manager
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.core.fork import build_forked_messages, is_in_fork_child
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult


class AgentToolInput(BaseModel):
    """Agent 工具输入"""

    description: str = Field(description="任务的简短描述（3-5 个词）")
    prompt: str = Field(description="agent 要执行的任务")
    model: str | None = Field(default=None, description="模型覆盖（可选）：sonnet, opus, haiku")
    run_in_background: bool = Field(default=True, description="是否在后台运行（默认为 True）")


class AgentToolOutput(BaseModel):
    """Agent 工具输出"""

    status: str  # fork_launched, error
    task_id: str | None = None
    description: str | None = None
    prompt: str | None = None
    output_file: str | None = None
    result: str | None = None
    turns_used: int | None = None


class AgentTool(Tool[AgentToolInput, AgentToolOutput]):
    """Agent 工具 — Fork 模式

    子 agent 继承父 agent 的完整对话上下文，在后台异步执行任务。
    """

    def __init__(self):
        self.name = "Agent"
        self.description = (
            "Launch a new agent to handle complex, multi-step tasks. "
            "The agent inherits your full conversation context (fork mode) "
            "and runs in the background."
        )
        self.max_result_size_chars = 100_000
        self.risk_level = ToolRiskLevel.MODERATE

    async def call(
        self,
        args: AgentToolInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[AgentToolOutput]:
        if isinstance(args, dict):
            args = AgentToolInput(**args)

        if is_in_fork_child(context.current_messages):
            return ToolResult(
                data=AgentToolOutput(
                    status="error",
                    result="Error: Cannot fork from within a fork child. Execute directly instead.",
                )
            )

        return await self._run_fork_mode(args, context, parent_message)

    async def _run_fork_mode(
        self,
        args: AgentToolInput,
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[AgentToolOutput]:
        fork_messages = build_forked_messages(args.prompt, parent_message)

        sub_context = ToolUseContext(
            options=ToolOptions(
                tools=context.options.tools,
                model=args.model or context.options.model,
                max_tokens=context.options.max_tokens,
            ),
            session_id=f"{context.session_id}/fork-{uuid4().hex[:8]}",
            cwd=context.cwd,
            thinking=context.thinking,
            permission_mode=context.permission_mode,
            permission_manager=context.permission_manager,
            is_server_mode=context.is_server_mode,
            read_file_state={},
            workspace_root=context.workspace_root,
            sandbox_session_id=context.sandbox_session_id,
        )

        full_messages = [*context.current_messages, *fork_messages]

        task_manager = get_task_manager()
        output_dir = Path.cwd() / ".ripple" / "tasks"
        task = task_manager.create_task(
            description=args.description,
            prompt=args.prompt,
            output_dir=output_dir,
        )

        from ripple.api.client import OpenRouterClient
        from ripple.core.agent_loop import QueryParams, query_loop

        client = OpenRouterClient()
        params = QueryParams(
            messages=full_messages,
            tool_use_context=sub_context,
            model=sub_context.options.model,
            max_turns=20,
            thinking=context.thinking,
        )

        task_manager.start_task(task, query_loop(params, client))

        output = AgentToolOutput(
            status="fork_launched",
            task_id=task.task_id,
            description=args.description,
            prompt=args.prompt,
            output_file=str(task.output_file) if task.output_file else None,
        )

        notification = create_task_notification(task)

        return ToolResult(data=output, new_messages=[notification])

    def requires_confirmation(self, input_params: dict) -> bool:
        return True

    def is_concurrency_safe(self, input: AgentToolInput | dict[str, Any]) -> bool:
        return True

    def _get_parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "A short (3-5 word) description of the task",
                },
                "prompt": {
                    "type": "string",
                    "description": "The task for the agent to perform",
                },
                "model": {
                    "type": "string",
                    "enum": ["sonnet", "opus", "haiku"],
                    "description": "Optional model override for this agent",
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "Run in the background (default: true)",
                },
            },
            "required": ["description", "prompt"],
        }
