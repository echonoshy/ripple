"""核心 Agent Loop 实现

Ripple 的主循环，类似 claude-code 的 agent loop 职责：
1. 维护消息历史并按需触发压缩
2. 流式调用模型 API
3. 执行工具、跨轮去重、合并结果
4. 在错误（PTL / max_output_tokens）或终止条件下做状态转移

错误识别 / 元数据提取见 `errors.py`；stop hooks 见 `stop_hooks.py`；
入参见 `query_params.py`。
"""

import asyncio
from typing import TYPE_CHECKING, Any, AsyncGenerator

from ripple.api.client import LLMClient, create_client
from ripple.core.context import ToolUseContext
from ripple.core.errors import (
    CONNECTION_RETRY_BACKOFF_BASE,
    MAX_CONNECTION_RETRIES,
    MAX_REACTIVE_COMPACT_RETRIES,
    extract_stop_metadata,
    is_context_too_long_error,
    is_max_output_error,
    is_retryable_connection_error,
    parse_ptl_token_gap,
)
from ripple.core.query_params import QueryParams
from ripple.core.state import QueryState
from ripple.core.stop_hooks import handle_stop_hooks
from ripple.core.transitions import (
    ContinueMaxOutputTokensEscalate,
    ContinueNextTurn,
    ContinueReactiveCompactRetry,
    ContinueStopHookBlocking,
    TerminalCompleted,
    TerminalMaxTurns,
    TerminalModelError,
    TerminalPromptTooLong,
    TerminalStopHookPrevented,
)
from ripple.messages.types import (
    AgentStopEvent,
    AssistantMessage,
    Message,
    RequestStartEvent,
    StreamEvent,
)
from ripple.messages.utils import (
    create_user_message,
    deserialize_message,
    extract_tool_use_blocks,
)
from ripple.utils.logger import get_logger

if TYPE_CHECKING:
    from ripple.compact.auto_compact import AutoCompactor

logger = get_logger("core.agent_loop")

__all__ = ["QueryParams", "query", "query_loop"]

# 达到最大轮数时的提示消息
_MAX_TURNS_NOTICE = (
    'Reached max turn limit ({max_turns} turns, currently at turn {turn_count}). Reply "continue" to keep going.'
)


def _collect_tools(context: ToolUseContext) -> list[Any]:
    """收集上下文中可用的工具对象（BaseTool 实例），具体格式转换由 client 自行处理"""
    return list(context.options.tools)


def _sync_current_messages(
    root_context: ToolUseContext, active_context: ToolUseContext, messages: list[Message]
) -> None:
    """把当前模型上下文同步回 root context，供 server 持久化 model_messages。"""
    snapshot = list(messages)
    active_context.current_messages = snapshot
    if root_context is not active_context:
        root_context.current_messages = snapshot


async def query_loop(
    params: QueryParams,
    client: LLMClient,
) -> AsyncGenerator[Message | StreamEvent | RequestStartEvent | AgentStopEvent, None]:
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

    from ripple.compact.auto_compact import AutoCompactor
    from ripple.core.recovery import ErrorRecovery

    compactor = params.compactor or AutoCompactor()
    recovery = ErrorRecovery()
    reactive_compact_count = 0
    last_microcompact_msg_count: int = 0
    # 跨轮累计的连接错误重试计数。仅在"本轮未产出任何 AssistantMessage 就失败"时递增；
    # 一旦有一轮成功产出消息就清零，避免偶发抖动累积到上限。
    connection_retry_count = 0
    root_context = params.tool_use_context

    # 从配置读取连接重试参数（见 config/settings.yaml: api.connection_retry）
    # errors.py 里的常量作为 fallback，避免配置缺失时崩溃
    from ripple.utils.config import get_config

    _api_cfg = get_config()
    max_connection_retries = int(_api_cfg.get("api.connection_retry.max_retries", MAX_CONNECTION_RETRIES))
    connection_retry_backoff_base = float(
        _api_cfg.get("api.connection_retry.backoff_base", CONNECTION_RETRY_BACKOFF_BASE)
    )

    while True:
        # ========== 阶段 0: 检查是否已被中止 ==========
        if state.tool_use_context.abort_signal and state.tool_use_context.abort_signal.is_aborted:
            logger.info("event=agent.abort turn={} reason=abort_signal", state.turn_count)
            return

        # ========== 阶段 0a: 轻量级清理 — 清理旧 tool_result / tool_input ==========
        msg_count = len(state.messages)
        if msg_count > last_microcompact_msg_count:
            compacted_micro = compactor.lightweight_cleanup(state.messages)
            if compacted_micro is not state.messages:
                state = state.with_messages(compacted_micro)
            last_microcompact_msg_count = msg_count

        # ========== 阶段 0b: 检查是否需要压缩 ==========
        if compactor.should_compact(state.messages):
            logger.info("开始压缩消息历史...")
            compacted_messages = await compactor.compact(state.messages, state.tool_use_context)

            state = state.with_messages(compacted_messages)
            last_microcompact_msg_count = 0  # 压缩后重置，让 microcompact 重新评估
            logger.info("压缩完成，当前消息数: {}", len(state.messages))

        # ========== 阶段 0.5: 任务提醒检查 ==========
        from ripple.utils.attachments import get_task_reminder_attachment

        task_reminder = get_task_reminder_attachment(
            state.messages,
            state.tool_use_context.session_runtime_dir,
        )
        if task_reminder:
            state = state.with_messages([*state.messages, task_reminder])

        # 同步当前消息到上下文，供 AgentTool fork 时读取
        _sync_current_messages(root_context, state.tool_use_context, state.messages)

        # ========== 阶段 1: 调用模型 ==========
        logger.info("event=agent.turn.start turn={} model={}", state.turn_count, params.model)
        yield RequestStartEvent(type="stream_request_start")

        assistant_messages: list[AssistantMessage] = []
        tool_use_blocks: list[dict[str, Any]] = []
        needs_follow_up = False
        early_tool_results: list[Message] = []

        from ripple.tools.streaming_executor import StreamingToolExecutor

        streaming_executor = StreamingToolExecutor(state.tool_use_context)

        tools = _collect_tools(state.tool_use_context)

        try:
            stream_kwargs: dict[str, Any] = {}
            if params.temperature is not None:
                stream_kwargs["temperature"] = params.temperature

            async for item in client.stream(
                messages=state.messages,
                tools=tools if tools else None,
                model=params.model,
                max_tokens=params.max_tokens,
                thinking=params.thinking,
                **stream_kwargs,
            ):
                yield item

                if not isinstance(item, AssistantMessage):
                    continue

                assistant_messages.append(item)

                # 用 API 返回的真实 token 数校准压缩器
                usage = item.message.get("usage", {})
                if usage:
                    prompt_tokens = usage.get("input_tokens", 0)
                    if prompt_tokens > 0:
                        compactor.calibrate_with_api_tokens(prompt_tokens)

                tool_uses = extract_tool_use_blocks(item)
                if tool_uses:
                    tool_use_blocks.extend(tool_uses)
                    needs_follow_up = True
                    for tu in tool_uses:
                        logger.info(
                            "event=agent.tool.detected turn={} tool={}",
                            state.turn_count,
                            tu.get("name", "unknown"),
                        )
                        streaming_executor.add_tool(tu, item)

                for completed in streaming_executor.get_completed_results():
                    if completed.message:
                        yield completed.message
                        early_tool_results.append(completed.message)
                    if completed.new_context:
                        state.tool_use_context = completed.new_context

        except Exception as e:
            streaming_executor.discard()
            logger.exception("API 调用失败: {}", e)

            error_str = str(e).lower()

            # 检查是否是可重试的连接/网络错误
            # 前置条件：本轮尚未产出任何 AssistantMessage —— 否则重试会产生重复消息污染历史
            if is_retryable_connection_error(error_str) and not assistant_messages:
                if connection_retry_count < max_connection_retries:
                    connection_retry_count += 1
                    backoff = connection_retry_backoff_base * (2 ** (connection_retry_count - 1))
                    logger.warning(
                        "检测到可重试的连接错误，{}s 后重试 (尝试 {}/{})",
                        backoff,
                        connection_retry_count,
                        max_connection_retries,
                    )
                    await asyncio.sleep(backoff)
                    # state / turn_count 均保持不变，直接重入循环重新调用模型
                    continue
                else:
                    logger.error(
                        "连接错误已达最大重试次数 {}，终止本次 query",
                        max_connection_retries,
                    )

            # 检查是否是上下文过长的错误 → reactive compact
            if is_context_too_long_error(error_str):
                if reactive_compact_count < MAX_REACTIVE_COMPACT_RETRIES:
                    reactive_compact_count += 1

                    # 尝试从错误消息中解析精确的 token 超额量
                    token_gap = parse_ptl_token_gap(error_str)

                    logger.warning(
                        "检测到上下文过长错误，执行 reactive compact (尝试 {}/{}, gap={})",
                        reactive_compact_count,
                        MAX_REACTIVE_COMPACT_RETRIES,
                        token_gap,
                    )

                    compacted = await compactor.reactive_compact(
                        state.messages, state.tool_use_context, token_gap=token_gap
                    )
                    last_microcompact_msg_count = 0  # 压缩后重置
                    state = state.with_messages(compacted).with_transition(ContinueReactiveCompactRetry())
                    continue
                else:
                    logger.error("reactive compact 已达最大重试次数，无法继续")
                    error_msg = create_user_message(
                        content="Context is still too long after compaction. Please start a new conversation.",
                        is_meta=True,
                    )
                    yield error_msg
                    _sync_current_messages(root_context, state.tool_use_context, [*state.messages, error_msg])
                    state = state.with_transition(TerminalPromptTooLong())
                    return

            # 检查是否是 max_output_tokens 错误
            if is_max_output_error(error_str):
                # 阶段 1: 先尝试升级 max_tokens（不注入 recovery 消息）
                if recovery.can_escalate_max_output_tokens():
                    escalated_max = recovery.get_escalated_max_tokens()
                    logger.info("检测到 max_output_tokens 错误，升级 max_tokens 到 {}", escalated_max)
                    params.max_tokens = escalated_max

                    state = (
                        state.with_messages([*state.messages, *assistant_messages])
                        .with_turn_count(state.turn_count + 1)
                        .with_transition(ContinueMaxOutputTokensEscalate())
                    )
                    if params.max_turns and state.turn_count > params.max_turns:
                        logger.warning("升级后达到最大轮数 {}，暂停循环等待用户确认", params.max_turns)
                        notice = create_user_message(
                            content=_MAX_TURNS_NOTICE.format(max_turns=params.max_turns, turn_count=state.turn_count),
                            is_meta=True,
                        )
                        yield notice
                        yield AgentStopEvent(
                            stop_reason="max_turns",
                            metadata={
                                "question": f"Reached max turn limit after {state.turn_count} turns. Continue?",
                                "options": ["Continue", "Stop"],
                            },
                        )
                        _sync_current_messages(root_context, state.tool_use_context, [*state.messages, notice])
                        state = state.with_transition(TerminalMaxTurns(turn_count=state.turn_count))
                        return
                    continue

                # 阶段 2: 升级已尝试过，回退到注入 recovery 消息
                if recovery.can_recover_max_output_tokens():
                    logger.info("升级无效，注入 recovery 消息恢复")
                    recovery_msg = recovery.create_recovery_message()
                    yield recovery_msg

                    state = state.with_messages([*state.messages, *assistant_messages, recovery_msg]).with_turn_count(
                        state.turn_count + 1
                    )
                    if params.max_turns and state.turn_count > params.max_turns:
                        logger.warning("恢复后达到最大轮数 {}，暂停循环等待用户确认", params.max_turns)
                        notice = create_user_message(
                            content=_MAX_TURNS_NOTICE.format(max_turns=params.max_turns, turn_count=state.turn_count),
                            is_meta=True,
                        )
                        yield notice
                        yield AgentStopEvent(
                            stop_reason="max_turns",
                            metadata={
                                "question": f"Reached max turn limit after {state.turn_count} turns. Continue?",
                                "options": ["Continue", "Stop"],
                            },
                        )
                        _sync_current_messages(root_context, state.tool_use_context, [*state.messages, notice])
                        state = state.with_transition(TerminalMaxTurns(turn_count=state.turn_count))
                        return
                    continue

            from ripple.utils.errors import error_message

            error_msg = create_user_message(
                content=f"API Error: {error_message(e)}",
                is_meta=True,
            )
            yield error_msg
            _sync_current_messages(
                root_context, state.tool_use_context, [*state.messages, *assistant_messages, error_msg]
            )
            state = state.with_transition(TerminalModelError(error=e))
            return

        if assistant_messages:
            total_content_blocks = sum(len(m.message.get("content", [])) for m in assistant_messages)
            logger.info(
                "event=agent.turn.model_result turn={} assistant_messages={} content_blocks={} tool_calls={}",
                state.turn_count,
                len(assistant_messages),
                total_content_blocks,
                len(tool_use_blocks),
            )
            # 本轮成功产出 → 清零连接错误重试计数，避免偶发抖动累积
            connection_retry_count = 0
        else:
            logger.warning("event=agent.turn.empty_response turn={}", state.turn_count)

        # ========== 阶段 2: 判断是否需要继续 ==========
        if not needs_follow_up:
            stop_result = await handle_stop_hooks(
                state.messages,
                assistant_messages,
                state.tool_use_context,
            )

            if stop_result.prevent_continuation:
                _sync_current_messages(root_context, state.tool_use_context, [*state.messages, *assistant_messages])
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
            _sync_current_messages(root_context, state.tool_use_context, [*state.messages, *assistant_messages])
            return

        # ========== 阶段 3: 执行工具 ==========
        tool_results: list[Message] = list(early_tool_results)
        new_tool_blocks: list[dict[str, Any]] = []
        should_stop_loop = False
        loop_stop_reason: str | None = None
        loop_stop_metadata: dict[str, Any] = {}

        for completed in streaming_executor.get_completed_results():
            if completed.message:
                yield completed.message
                tool_results.append(completed.message)
            if completed.new_context:
                state.tool_use_context = completed.new_context
            if completed.stop_agent_loop:
                should_stop_loop = True
                loop_stop_reason = loop_stop_reason or completed.stop_reason
                if completed.stop_metadata and not loop_stop_metadata:
                    loop_stop_metadata = completed.stop_metadata

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
                    loop_stop_reason = loop_stop_reason or update.stop_reason
                    if update.stop_metadata and not loop_stop_metadata:
                        loop_stop_metadata = update.stop_metadata

        for block in tool_use_blocks:
            tool_id = block["id"]

            if tool_id in streaming_executor.started_tool_ids:
                continue

            new_tool_blocks.append(block)

        if new_tool_blocks:
            from ripple.tools.orchestration import run_tools

            tool_names = [b.get("name", "?") for b in new_tool_blocks]
            logger.info("event=agent.tools.start turn={} tools={}", state.turn_count, tool_names)

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
                        loop_stop_reason = loop_stop_reason or update.stop_reason
                        if update.stop_metadata and not loop_stop_metadata:
                            loop_stop_metadata = update.stop_metadata

            except Exception as e:
                logger.exception("工具执行失败: {}", e)

                from ripple.utils.errors import error_message

                error_msg = create_user_message(
                    content=f"Tool execution error: {error_message(e)}",
                    is_meta=True,
                )
                yield error_msg
                _sync_current_messages(
                    root_context, state.tool_use_context, [*state.messages, *assistant_messages, error_msg]
                )
                return

        # ========== 阶段 3.5: 检查是否需要暂停 agent loop ==========
        if should_stop_loop:
            final_messages = [*state.messages, *assistant_messages, *tool_results]
            logger.info(
                "event=agent.stop_requested turn={} reason={}",
                state.turn_count,
                loop_stop_reason or "unknown",
            )
            yield AgentStopEvent(
                stop_reason=loop_stop_reason or "tool_requested",
                metadata=loop_stop_metadata
                or extract_stop_metadata(loop_stop_reason or "tool_requested", tool_results),
            )
            state = state.with_messages(final_messages)
            _sync_current_messages(root_context, state.tool_use_context, final_messages)
            return

        # ========== 阶段 4: 检查最大轮数 ==========
        next_turn_count = state.turn_count + 1
        if params.max_turns and next_turn_count > params.max_turns:
            logger.warning("达到最大轮数 {}，暂停循环等待用户确认", params.max_turns)
            notice = create_user_message(
                content=_MAX_TURNS_NOTICE.format(max_turns=params.max_turns, turn_count=state.turn_count),
                is_meta=True,
            )
            yield notice
            yield AgentStopEvent(
                stop_reason="max_turns",
                metadata={
                    "question": f"Reached max turn limit after {state.turn_count} turns. Continue?",
                    "options": ["Continue", "Stop"],
                },
            )
            state = state.with_messages([*state.messages, *assistant_messages, *tool_results])
            state = state.with_transition(TerminalMaxTurns(turn_count=state.turn_count))
            _sync_current_messages(root_context, state.tool_use_context, state.messages)
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
        _sync_current_messages(root_context, state.tool_use_context, state.messages)


# 简化的入口函数
async def query(
    user_input: str,
    context: ToolUseContext,
    client: LLMClient | None = None,
    model: str = "anthropic/claude-sonnet-4.6",
    max_turns: int | None = None,
    thinking: bool | None = None,
    history_messages: list[Message] | None = None,
    system_prompt: str | None = None,
    compactor: "AutoCompactor | None" = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> AsyncGenerator[Message | StreamEvent | RequestStartEvent | AgentStopEvent, None]:
    """查询入口函数"""
    if client is None:
        client = create_client()

    messages = []

    from ripple.messages.utils import create_system_message
    from ripple.utils.time import current_time_context

    if system_prompt:
        messages.append(create_system_message(content=system_prompt))
    else:
        messages.append(
            create_system_message(
                content=(
                    f"{current_time_context()} "
                    "Use this date when searching for current information or answering time-sensitive questions."
                )
            )
        )

    if history_messages:
        for hm in history_messages:
            messages.append(deserialize_message(hm) if isinstance(hm, dict) else hm)

    messages.append(create_user_message(content=user_input))

    params = QueryParams(
        messages=messages,
        tool_use_context=context,
        model=model,
        max_turns=max_turns,
        thinking=thinking,
        compactor=compactor,
        temperature=temperature,
        max_tokens=max_tokens,
    )

    async for item in query_loop(params, client):
        yield item
