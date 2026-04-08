"""Agent 工具

支持两种模式：
1. Fork 模式（默认）：继承父 agent 的完整对话上下文，后台运行
2. SubAgent 模式：指定 agent 类型（如 explore, plan），独立上下文
"""

from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from ripple.core.background import create_task_notification, get_task_manager
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.core.fork import build_forked_messages, is_in_fork_child
from ripple.messages.types import AssistantMessage, Message
from ripple.tools.base import Tool, ToolResult


class AgentToolInput(BaseModel):
    """Agent 工具输入"""

    description: str = Field(description="任务的简短描述（3-5 个词）")
    prompt: str = Field(description="agent 要执行的任务")
    subagent_type: str | None = Field(
        default=None,
        description="专用 agent 类型（可选）。如果省略，则使用 fork 模式继承完整上下文",
    )
    model: str | None = Field(default=None, description="模型覆盖（可选）：sonnet, opus, haiku")
    run_in_background: bool = Field(default=True, description="是否在后台运行（fork 模式默认为 True）")


class AgentToolOutput(BaseModel):
    """Agent 工具输出"""

    status: str  # fork_launched, subagent_completed
    task_id: str | None = None
    description: str | None = None
    prompt: str | None = None
    output_file: str | None = None
    result: str | None = None
    turns_used: int | None = None


class AgentTool(Tool[AgentToolInput, AgentToolOutput]):
    """Agent 工具

    支持两种模式：
    1. Fork 模式（默认）：子 agent 继承父 agent 的完整对话上下文
    2. SubAgent 模式：指定 subagent_type，子 agent 有独立上下文
    """

    def __init__(self, messages: list[Message] | None = None):
        self.name = "Agent"
        self.description = (
            "Launch a new agent to handle complex, multi-step tasks. "
            "By default (no subagent_type), the agent inherits your full conversation context (fork mode). "
            "Specify subagent_type for specialized agents with independent context."
        )
        self.max_result_size_chars = 100_000
        self.messages = messages or []  # 父 agent 的消息历史

    async def call(
        self,
        args: AgentToolInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[AgentToolOutput]:
        """执行 Agent 工具

        Args:
            args: 工具参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            工具执行结果
        """
        # 解析输入
        if isinstance(args, dict):
            args = AgentToolInput(**args)

        # 防递归检查
        if is_in_fork_child(self.messages):
            return ToolResult(
                data=AgentToolOutput(
                    status="error",
                    result="Error: Cannot fork from within a fork child. Execute directly instead.",
                )
            )

        # 判断模式
        if args.subagent_type:
            # SubAgent 模式：独立上下文
            return await self._run_subagent_mode(args, context, parent_message)
        else:
            # Fork 模式：继承上下文
            return await self._run_fork_mode(args, context, parent_message)

    async def _run_fork_mode(
        self,
        args: AgentToolInput,
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[AgentToolOutput]:
        """Fork 模式：继承父 agent 的完整对话上下文

        Args:
            args: 工具参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            工具执行结果
        """
        # 构建 fork 消息
        fork_messages = build_forked_messages(args.prompt, parent_message)

        # 创建子上下文（继承父 agent 的工具列表）
        sub_context = ToolUseContext(
            options=ToolOptions(
                tools=context.options.tools,  # 继承所有工具
                model=args.model or context.options.model,
                max_tokens=context.options.max_tokens,
                temperature=context.options.temperature,
            ),
            session_id=f"{context.session_id}/fork-{uuid4().hex[:8]}",
            cwd=context.cwd,
            permission_mode=context.permission_mode,
            read_file_state={},  # 独立的文件读取状态
        )

        # 合并消息：父历史 + fork 消息
        full_messages = [*self.messages, *fork_messages]

        # 创建后台任务
        task_manager = get_task_manager()
        output_dir = Path.cwd() / ".ripple" / "tasks"
        task = task_manager.create_task(
            description=args.description,
            prompt=args.prompt,
            output_dir=output_dir,
        )

        # 启动后台任务
        from ripple.api.client import OpenRouterClient
        from ripple.core.agent_loop import QueryParams, query_loop

        client = OpenRouterClient()
        params = QueryParams(
            messages=full_messages,
            tool_use_context=sub_context,
            model=sub_context.options.model,
            max_turns=200,  # fork 模式允许更多轮数
        )

        task_manager.start_task(task, query_loop(params, client))

        # 返回任务启动通知
        output = AgentToolOutput(
            status="fork_launched",
            task_id=task.task_id,
            description=args.description,
            prompt=args.prompt,
            output_file=str(task.output_file) if task.output_file else None,
        )

        # 创建通知消息
        notification = create_task_notification(task)

        return ToolResult(data=output, new_messages=[notification])

    async def _run_subagent_mode(
        self,
        args: AgentToolInput,
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[AgentToolOutput]:
        """SubAgent 模式：独立上下文

        Args:
            args: 工具参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            工具执行结果
        """
        # TODO: 实现 subagent_type 模式
        # 需要：
        # 1. 加载 agent 定义（从 agents/ 目录）
        # 2. 根据 agent 定义创建系统提示
        # 3. 过滤工具列表
        # 4. 运行独立的 agent loop

        return ToolResult(
            data=AgentToolOutput(
                status="error",
                result=f"SubAgent mode (subagent_type={args.subagent_type}) not implemented yet. Use fork mode instead (omit subagent_type).",
            )
        )

    def is_concurrency_safe(self, input: AgentToolInput | dict[str, Any]) -> bool:
        """Agent 工具是并发安全的

        每个 agent 有独立的 session_id 和上下文，不共享状态。

        Args:
            input: 输入参数

        Returns:
            True
        """
        return True

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema

        Returns:
            JSON Schema
        """
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
                "subagent_type": {
                    "type": "string",
                    "description": "The type of specialized agent to use for this task (optional). If omitted, uses fork mode with full context inheritance.",
                },
                "model": {
                    "type": "string",
                    "enum": ["sonnet", "opus", "haiku"],
                    "description": "Optional model override for this agent",
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "Set to true to run this agent in the background (default: true for fork mode)",
                },
            },
            "required": ["description", "prompt"],
        }
