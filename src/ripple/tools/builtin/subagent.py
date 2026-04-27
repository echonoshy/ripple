"""SubAgent 工具

启动子 agent 处理复杂子任务。
"""

from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.messages.utils import create_user_message
from ripple.tools.base import Tool, ToolResult


class SubAgentInput(BaseModel):
    """SubAgent 工具输入"""

    prompt: str = Field(description="子任务的提示词")
    max_turns: int | None = Field(default=None, description="子 agent 的最大轮数（为空则使用配置文件默认值）")
    allowed_tools: list[str] | None = Field(
        default=None,
        description="允许子 agent 使用的工具列表（如 ['Read', 'Bash']），为空则使用配置文件默认值",
    )


class SubAgentOutput(BaseModel):
    """SubAgent 工具输出"""

    result: str
    turns_used: int
    execution_log: list[dict] = []  # 执行日志：记录所有工具调用和结果


class SubAgentTool(Tool[SubAgentInput, SubAgentOutput]):
    """SubAgent 工具

    启动一个子 agent 来处理复杂的子任务。
    子 agent 有独立的上下文和受限的工具集，不能再创建子 agent（防止递归）。
    """

    def __init__(self):
        self.name = "SubAgent"
        self.description = (
            "Spawn a sub-agent to handle a complex subtask. "
            "The sub-agent has its own context and limited tool access. "
            "Use this when you need to delegate a well-defined subtask."
        )
        self.max_result_size_chars = 50_000

    async def call(
        self,
        args: SubAgentInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[SubAgentOutput]:
        """启动子 agent

        Args:
            args: 子 agent 参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            子 agent 的执行结果
        """
        # 解析输入
        if isinstance(args, dict):
            args = SubAgentInput(**args)

        try:
            # 加载配置
            from ripple.utils.config import get_config

            config = get_config()

            # 获取配置的默认值
            max_turns = args.max_turns or config.get("tools.subagent.default_max_turns", 5)
            allowed_tools = args.allowed_tools
            if allowed_tools is None:
                allowed_tools = config.get("tools.subagent.default_allowed_tools", [])
            permission_mode = config.get("tools.subagent.permission_mode", "allow")

            # 1. 创建子工具列表：移除 SubAgentTool 防止递归
            sub_tools = [t for t in context.options.tools if t.name != "SubAgent"]

            # 2. 如果指定了 allowed_tools，进一步过滤
            if allowed_tools:
                allowed_names = set(allowed_tools)
                sub_tools = [t for t in sub_tools if t.name in allowed_names]

            if not sub_tools:
                return ToolResult(
                    data=SubAgentOutput(
                        result="Error: No tools available for sub-agent. Check allowed_tools parameter.",
                        turns_used=0,
                    )
                )

            # 3. 创建子上下文（继承父 agent 的权限管理器）
            sub_context = ToolUseContext(
                options=ToolOptions(
                    tools=sub_tools,
                    model=context.options.model,
                    max_tokens=context.options.max_tokens,
                ),
                session_id=f"{context.session_id}/sub-{uuid4().hex[:8]}",
                cwd=context.cwd,
                thinking=context.thinking,
                permission_mode=permission_mode,
                permission_manager=context.permission_manager,
                read_file_state={},
                workspace_root=context.workspace_root,
                sandbox_session_id=context.sandbox_session_id,
                session_runtime_dir=context.session_runtime_dir,
                user_id=context.user_id,
                sandbox_manager=context.sandbox_manager,
                sandboxed=context.sandboxed,
            )

            # 4. 调用 query_loop
            from ripple.api.client import create_client
            from ripple.core.agent_loop import QueryParams, query_loop

            client = create_client()

            sub_params = QueryParams(
                messages=[create_user_message(args.prompt)],
                tool_use_context=sub_context,
                model=context.options.model,
                max_turns=max_turns,
                max_tokens=context.options.max_tokens,
                thinking=context.thinking,
            )

            # 5. 收集输出和执行日志
            text_outputs = []
            turns_used = 0
            execution_log = []

            async for item in query_loop(sub_params, client):
                if isinstance(item, AssistantMessage):
                    turns_used += 1
                    # 提取文本内容
                    for block in item.message.get("content", []):
                        if isinstance(block, dict):
                            if block.get("type") == "text":
                                text = block.get("text", "").strip()
                                if text:
                                    text_outputs.append(text)
                                    execution_log.append(
                                        {
                                            "type": "assistant_text",
                                            "content": text[:200] + ("..." if len(text) > 200 else ""),
                                        }
                                    )
                            elif block.get("type") == "tool_use":
                                # 记录工具调用
                                execution_log.append(
                                    {
                                        "type": "tool_call",
                                        "tool_name": block.get("name", ""),
                                        "tool_input": block.get("input", {}),
                                    }
                                )

                elif hasattr(item, "type") and item.type == "user":
                    # 记录工具结果
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            result_content = block.get("content", "")
                            is_error = block.get("is_error", False)
                            execution_log.append(
                                {
                                    "type": "tool_result",
                                    "is_error": is_error,
                                    "content": result_content[:200] + ("..." if len(result_content) > 200 else ""),
                                }
                            )

            # 6. 返回结果
            if text_outputs:
                result = "\n\n".join(text_outputs)
            else:
                result = "Sub-agent completed with no text output."

            output = SubAgentOutput(
                result=result,
                turns_used=turns_used,
                execution_log=execution_log,
            )

            return ToolResult(data=output)

        except Exception as e:
            from ripple.utils.errors import error_message

            output = SubAgentOutput(
                result=f"Sub-agent execution failed: {error_message(e)}",
                turns_used=0,
                execution_log=[],
            )
            return ToolResult(data=output)

    def is_concurrency_safe(self, input: SubAgentInput | dict[str, Any]) -> bool:
        """SubAgent 是并发安全的

        每个子 agent 有独立的 session_id 和上下文，不共享状态。

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
                "prompt": {
                    "type": "string",
                    "description": "The task prompt for the sub-agent",
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Maximum number of turns for the sub-agent (default: from config or 5)",
                },
                "allowed_tools": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of tool names the sub-agent can use (e.g., ['Read', 'Bash']). If not specified, all tools except SubAgent are allowed.",
                },
            },
            "required": ["prompt"],
        }
