"""核心 Agent Loop 实现

这是整个 Ripple 系统的核心，实现了类似 claude-code 的主循环逻辑。
"""

import json
from typing import Any, AsyncGenerator

from ripple.api.client import OpenRouterClient
from ripple.api.streaming import process_stream_response
from ripple.core.context import ToolUseContext
from ripple.core.state import QueryState
from ripple.core.transitions import (
    ContinueNextTurn,
    ContinueStopHookBlocking,
    TerminalCompleted,
    TerminalMaxTurns,
    TerminalModelError,
    TerminalStopHookPrevented,
)
from ripple.messages.types import AssistantMessage, Message, RequestStartEvent, StreamEvent
from ripple.messages.utils import (
    create_tool_result_message,
    create_user_message,
    extract_tool_use_blocks,
    normalize_messages_for_api,
)
from ripple.utils.logger import get_logger

logger = get_logger("core.agent_loop")


class QueryParams:
    """查询参数"""

    def __init__(
        self,
        messages: list[Message],
        tool_use_context: ToolUseContext,
        model: str = "anthropic/claude-sonnet-4.6",
        max_turns: int | None = None,
        max_tokens: int | None = None,
        thinking: bool | None = None,
    ):
        self.messages = messages
        self.tool_use_context = tool_use_context
        self.model = model
        self.max_turns = max_turns
        self.max_tokens = max_tokens
        self.thinking = thinking


async def query_loop(
    params: QueryParams,
    client: OpenRouterClient,
) -> AsyncGenerator[Message | StreamEvent | RequestStartEvent, None]:
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
    """
    state = QueryState(
        messages=params.messages,
        tool_use_context=params.tool_use_context,
        turn_count=1,
    )

    executed_tool_keys: set[str] = set()

    # 每个 query_loop 创建独立的压缩器和错误恢复实例，避免跨会话状态污染
    from ripple.compact.auto_compact import AutoCompactor
    from ripple.recovery.error_recovery import ErrorRecovery

    compactor = AutoCompactor()
    recovery = ErrorRecovery()

    while True:
        # ========== 阶段 0a: Microcompact — 清理旧 tool_result ==========
        from ripple.compact.micro_compact import microcompact_messages

        compacted_micro = microcompact_messages(state.messages)
        if compacted_micro is not state.messages:
            state = state.with_messages(compacted_micro)

        # ========== 阶段 0b: 检查是否需要压缩 ==========
        if compactor.should_compact(state.messages):
            logger.info("开始压缩消息历史...")
            compacted_messages = await compactor.compact(state.messages, state.tool_use_context)

            state = state.with_messages(compacted_messages)
            logger.info("压缩完成，当前消息数: {}", len(state.messages))

        # ========== 阶段 0.5: 任务提醒检查 ==========
        from ripple.utils.attachments import get_task_reminder_attachment

        task_reminder = get_task_reminder_attachment(state.messages, state.tool_use_context.cwd)
        if task_reminder:
            state = state.with_messages([*state.messages, task_reminder])

        # 同步当前消息到上下文，供 AgentTool fork 时读取
        state.tool_use_context.current_messages = list(state.messages)

        # ========== 阶段 1: 调用模型 ==========
        logger.info("Turn {}: 开始调用模型 {}", state.turn_count, params.model)
        yield RequestStartEvent(type="stream_request_start")

        assistant_messages: list[AssistantMessage] = []
        tool_use_blocks: list[dict[str, Any]] = []
        needs_follow_up = False
        early_tool_results: list[Message] = []

        # 创建流式工具执行器 — 在模型输出时提前启动并发安全的工具
        from ripple.tools.streaming_executor import StreamingToolExecutor

        streaming_executor = StreamingToolExecutor(state.tool_use_context)

        api_messages = normalize_messages_for_api(state.messages)

        tools = _prepare_tool_definitions(state.tool_use_context)

        try:
            stream = client.stream_chat(
                messages=api_messages,
                tools=tools if tools else None,
                model=params.model,
                max_tokens=params.max_tokens,
                thinking=params.thinking,
            )

            async for item in process_stream_response(stream):
                yield item

                if not isinstance(item, AssistantMessage):
                    continue

                assistant_messages.append(item)

                tool_uses = extract_tool_use_blocks(item)
                if tool_uses:
                    tool_use_blocks.extend(tool_uses)
                    needs_follow_up = True
                    for tu in tool_uses:
                        logger.info("检测到工具调用: {}", tu.get("name", "unknown"))
                        streaming_executor.add_tool(tu, item)

                # 在流式阶段就 yield 已完成的并行工具结果，同时追踪用于后续 state 更新
                for completed in streaming_executor.get_completed_results():
                    if completed.message:
                        yield completed.message
                        early_tool_results.append(completed.message)
                    if completed.new_context:
                        state.tool_use_context = completed.new_context

        except Exception as e:
            import traceback

            streaming_executor.discard()
            logger.error("API 调用失败: {}\n{}", e, traceback.format_exc())

            # 检查是否是 max_output_tokens 错误
            error_str = str(e).lower()
            if "max_output_tokens" in error_str or "output token" in error_str:
                if recovery.can_recover_max_output_tokens():
                    logger.info("检测到 max_output_tokens 错误，尝试恢复")
                    recovery_msg = recovery.create_recovery_message()
                    yield recovery_msg

                    # 继续下一轮
                    state = state.with_messages([*state.messages, *assistant_messages, recovery_msg])
                    continue

            from ripple.utils.errors import error_message

            error_msg = create_user_message(
                content=f"API Error: {error_message(e)}",
                is_meta=True,
            )
            yield error_msg
            state = state.with_transition(TerminalModelError(error=e))
            return

        if assistant_messages:
            total_content_blocks = sum(len(m.message.get("content", [])) for m in assistant_messages)
            logger.info(
                "Turn {}: 收到 {} 条助手消息, {} 个 content blocks, {} 个工具调用",
                state.turn_count,
                len(assistant_messages),
                total_content_blocks,
                len(tool_use_blocks),
            )
        else:
            logger.warning("Turn {}: 模型未返回任何消息（流式响应为空）", state.turn_count)

        # ========== 阶段 2: 判断是否需要继续 ==========
        if not needs_follow_up:
            stop_result = await _handle_stop_hooks(
                state.messages,
                assistant_messages,
                state.tool_use_context,
            )

            if stop_result.prevent_continuation:
                state = state.with_transition(TerminalStopHookPrevented())
                return

            if stop_result.blocking_errors:
                state = state.with_messages(
                    [
                        *state.messages,
                        *assistant_messages,
                        *stop_result.blocking_errors,
                    ]
                ).with_transition(ContinueStopHookBlocking())
                continue

            state = state.with_transition(TerminalCompleted())
            return

        # ========== 阶段 3: 跨轮次去重 + 执行工具 ==========
        tool_results: list[Message] = list(early_tool_results)
        new_tool_blocks: list[dict[str, Any]] = []
        should_stop_loop = False

        # 先收集流式阶段已完成的并行工具结果
        for completed in streaming_executor.get_completed_results():
            if completed.message:
                yield completed.message
                tool_results.append(completed.message)
            if completed.new_context:
                state.tool_use_context = completed.new_context
            if completed.stop_agent_loop:
                should_stop_loop = True

        # 等待所有已启动的流式工具完成
        if streaming_executor.has_pending_tools():
            remaining = await streaming_executor.get_remaining_results()
            for update in remaining:
                if update.message:
                    yield update.message
                    tool_results.append(update.message)
                if update.new_context:
                    state.tool_use_context = update.new_context
                if update.stop_agent_loop:
                    should_stop_loop = True

        for block in tool_use_blocks:
            tool_id = block["id"]

            # 跳过已被 streaming executor 处理的工具
            if tool_id in streaming_executor.started_tool_ids:
                continue

            key = json.dumps({"name": block.get("name"), "input": block.get("input", {})}, sort_keys=True)
            if key in executed_tool_keys:
                dup_msg = create_tool_result_message(
                    tool_use_id=block["id"],
                    content=(
                        "This tool was already called with identical arguments in a previous turn. "
                        "The result is already in the conversation above. "
                        "Do NOT call this tool again. "
                        "Use the previous result to respond to the user's question directly."
                    ),
                )
                yield dup_msg
                tool_results.append(dup_msg)
            else:
                new_tool_blocks.append(block)
                executed_tool_keys.add(key)

        if new_tool_blocks:
            from ripple.tools.orchestration import run_tools

            tool_names = [b.get("name", "?") for b in new_tool_blocks]
            logger.info("Turn {}: 执行工具 {}", state.turn_count, tool_names)

            try:
                async for update in run_tools(
                    new_tool_blocks,
                    assistant_messages,
                    state.tool_use_context,
                ):
                    if update.message:
                        yield update.message
                        tool_results.append(update.message)

                    if update.new_context:
                        state.tool_use_context = update.new_context

                    if update.stop_agent_loop:
                        should_stop_loop = True

            except Exception as e:
                import traceback

                logger.error("工具执行失败: {}\n{}", e, traceback.format_exc())

                from ripple.utils.errors import error_message

                error_msg = create_user_message(
                    content=f"Tool execution error: {error_message(e)}",
                    is_meta=True,
                )
                yield error_msg
                return

        # ========== 阶段 3.5: 检查是否需要暂停 agent loop ==========
        if should_stop_loop:
            logger.info("Turn {}: 工具请求暂停 agent loop（如 AskUser）", state.turn_count)
            state = state.with_messages([*state.messages, *assistant_messages, *tool_results])
            return

        # ========== 阶段 4: 检查最大轮数 ==========
        next_turn_count = state.turn_count + 1
        if params.max_turns and next_turn_count > params.max_turns:
            logger.warning("达到最大轮数 {}，终止循环", params.max_turns)
            state = state.with_transition(TerminalMaxTurns(turn_count=state.turn_count))
            return

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


def _prepare_tool_definitions(context: ToolUseContext) -> list[dict[str, Any]]:
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
    messages: list[Message],
    assistant_messages: list[AssistantMessage],
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
    from ripple.hooks.executor import StopHookResult, execute_stop_hooks

    try:
        return await execute_stop_hooks(messages, assistant_messages, context)
    except Exception as e:
        logger.error("Stop Hook 执行异常（已忽略，不阻止继续）: {}", e)
        return StopHookResult(
            blocking_errors=[],
            prevent_continuation=False,
        )


# 简化的入口函数
async def query(
    user_input: str,
    context: ToolUseContext,
    client: OpenRouterClient | None = None,
    model: str = "anthropic/claude-sonnet-4.6",
    max_turns: int | None = None,
    thinking: bool | None = None,
    history_messages: list[Message] | None = None,
    system_prompt: str | None = None,
) -> AsyncGenerator[Message | StreamEvent | RequestStartEvent, None]:
    """查询入口函数

    Args:
        user_input: 用户输入
        context: 工具使用上下文
        client: OpenRouter 客户端（可选）
        model: 模型名称
        max_turns: 最大轮数
        thinking: 是否启用思考模式
        history_messages: 历史消息列表（可选）
        system_prompt: 系统提示（可选）

    Yields:
        消息或流式事件
    """
    if client is None:
        client = OpenRouterClient()

    # 构建消息列表
    messages = []

    # 系统消息
    from datetime import datetime

    from ripple.messages.utils import create_system_message

    if system_prompt:
        messages.append(create_system_message(content=system_prompt))
    else:
        current_date = datetime.now().strftime("%Y/%m/%d")
        workspace_dir = context.cwd / ".ripple" / "workspace"
        messages.append(
            create_system_message(
                content=(
                    f"Today's date is {current_date}. Use this date when searching for current information or answering time-sensitive questions.\n\n"
                    f"When writing or saving files, use `{workspace_dir}` as the default output directory. "
                    f"Do NOT write to the user's home directory, root directory, or any system directory."
                )
            )
        )

    # 历史消息
    if history_messages:
        messages.extend(history_messages)

    # 新用户消息
    messages.append(create_user_message(content=user_input))

    params = QueryParams(
        messages=messages,
        tool_use_context=context,
        model=model,
        max_turns=max_turns,
        thinking=thinking,
    )

    async for item in query_loop(params, client):
        yield item
