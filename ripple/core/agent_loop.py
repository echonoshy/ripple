"""核心 Agent Loop 实现

这是整个 Ripple 系统的核心，实现了类似 claude-code 的主循环逻辑。
"""

from typing import Any, AsyncGenerator, Dict, List

from ripple.api.client import OpenRouterClient
from ripple.api.streaming import process_stream_response
from ripple.core.context import ToolUseContext
from ripple.core.state import QueryState
from ripple.core.transitions import (
    ContinueNextTurn,
    ContinueStopHookBlocking,
    Terminal,
    TerminalAbortedTools,
    TerminalCompleted,
    TerminalMaxTurns,
    TerminalStopHookPrevented,
)
from ripple.messages.types import AssistantMessage, Message, StreamEvent
from ripple.messages.utils import (
    create_user_message,
    extract_tool_use_blocks,
    normalize_messages_for_api,
)


class QueryParams:
    """查询参数"""

    def __init__(
        self,
        messages: List[Message],
        tool_use_context: ToolUseContext,
        model: str = "anthropic/claude-3.5-sonnet",
        max_turns: int | None = None,
        max_tokens: int | None = None,
    ):
        self.messages = messages
        self.tool_use_context = tool_use_context
        self.model = model
        self.max_turns = max_turns
        self.max_tokens = max_tokens


async def query_loop(
    params: QueryParams,
    client: OpenRouterClient,
) -> AsyncGenerator[Message | StreamEvent, Terminal]:
    """主 Agent 循环

    这是 Ripple 的核心循环，负责：
    1. 调用模型 API
    2. 检测工具调用
    3. 执行工具
    4. 判断是否继续或终止

    Args:
        params: 查询参数
        client: OpenRouter 客户端

    Yields:
        消息或流式事件

    Returns:
        终止原因
    """
    # 初始化状态
    state = QueryState(
        messages=params.messages,
        tool_use_context=params.tool_use_context,
        turn_count=1,
    )

    # 主循环
    while True:
        # ========== 阶段 1: 调用模型 ==========
        yield StreamEvent(type="stream_request_start")

        assistant_messages: List[AssistantMessage] = []
        tool_use_blocks: List[Dict[str, Any]] = []
        needs_follow_up = False

        # 规范化消息用于 API
        api_messages = normalize_messages_for_api(state.messages)

        # 准备工具定义
        tools = _prepare_tool_definitions(state.tool_use_context)

        # 流式调用模型
        try:
            stream = client.stream_chat(
                messages=api_messages,
                tools=tools if tools else None,
                model=params.model,
                max_tokens=params.max_tokens,
            )

            async for message in process_stream_response(stream):
                yield message
                assistant_messages.append(message)

                # 检测工具调用
                tool_uses = extract_tool_use_blocks(message)
                if tool_uses:
                    tool_use_blocks.extend(tool_uses)
                    needs_follow_up = True

        except Exception as e:
            # API 错误处理
            from ripple.utils.errors import error_message

            error_msg = create_user_message(
                content=f"API Error: {error_message(e)}",
                is_meta=True,
            )
            yield error_msg
            return TerminalCompleted()

        # ========== 阶段 2: 判断是否需要继续 ==========
        if not needs_follow_up:
            # 没有工具调用，检查 Stop Hooks
            stop_result = await _handle_stop_hooks(
                state.messages,
                assistant_messages,
                state.tool_use_context,
            )

            if stop_result.prevent_continuation:
                return TerminalStopHookPrevented()

            if stop_result.blocking_errors:
                # 注入错误消息，继续循环让模型修复
                state = state.with_messages(
                    [
                        *state.messages,
                        *assistant_messages,
                        *stop_result.blocking_errors,
                    ]
                ).with_transition(ContinueStopHookBlocking())
                continue

            # 任务完成
            return TerminalCompleted()

        # ========== 阶段 3: 执行工具 ==========
        tool_results: List[Message] = []

        # 导入工具编排模块（延迟导入避免循环依赖）
        from ripple.tools.orchestration import run_tools

        try:
            async for update in run_tools(
                tool_use_blocks,
                assistant_messages,
                state.tool_use_context,
            ):
                if update.message:
                    yield update.message
                    tool_results.append(update.message)

                if update.new_context:
                    state.tool_use_context = update.new_context

        except Exception as e:
            # 工具执行错误
            from ripple.utils.errors import error_message

            error_msg = create_user_message(
                content=f"Tool execution error: {error_message(e)}",
                is_meta=True,
            )
            yield error_msg
            return TerminalAbortedTools()

        # ========== 阶段 4: 检查最大轮数 ==========
        next_turn_count = state.turn_count + 1
        if params.max_turns and next_turn_count > params.max_turns:
            return TerminalMaxTurns(turn_count=next_turn_count)

        # ========== 阶段 5: 继续下一轮 ==========
        state = (
            state.with_messages(
                [
                    *state.messages,
                    *assistant_messages,
                    *tool_results,
                ]
            )
            .with_turn_count(next_turn_count)
            .with_transition(ContinueNextTurn())
        )


def _prepare_tool_definitions(context: ToolUseContext) -> List[Dict[str, Any]]:
    """准备工具定义用于 API 调用

    Args:
        context: 工具使用上下文

    Returns:
        工具定义列表
    """
    tools = []
    for tool in context.options.tools:
        # 每个工具需要提供 to_openai_tool() 方法
        if hasattr(tool, "to_openai_tool"):
            tools.append(tool.to_openai_tool())
    return tools


async def _handle_stop_hooks(
    messages: List[Message],
    assistant_messages: List[AssistantMessage],
    context: ToolUseContext,
):
    """处理 Stop Hooks

    Args:
        messages: 消息列表
        assistant_messages: 助手消息列表
        context: 工具使用上下文

    Returns:
        Stop Hook 结果
    """
    # 延迟导入避免循环依赖
    from ripple.hooks.executor import StopHookResult, execute_stop_hooks

    try:
        return await execute_stop_hooks(messages, assistant_messages, context)
    except Exception:
        # Hook 执行失败，不阻止继续
        return StopHookResult(
            blocking_errors=[],
            prevent_continuation=False,
        )


# 简化的入口函数
async def query(
    user_input: str,
    context: ToolUseContext,
    client: OpenRouterClient | None = None,
    model: str = "anthropic/claude-3.5-sonnet",
    max_turns: int | None = None,
) -> AsyncGenerator[Message | StreamEvent, Terminal]:
    """查询入口函数

    Args:
        user_input: 用户输入
        context: 工具使用上下文
        client: OpenRouter 客户端（可选）
        model: 模型名称
        max_turns: 最大轮数

    Yields:
        消息或流式事件

    Returns:
        终止原因
    """
    if client is None:
        client = OpenRouterClient()

    # 创建初始消息
    initial_message = create_user_message(content=user_input)

    params = QueryParams(
        messages=[initial_message],
        tool_use_context=context,
        model=model,
        max_turns=max_turns,
    )

    async for item in query_loop(params, client):
        yield item

    # 返回终止原因
    return TerminalCompleted()
