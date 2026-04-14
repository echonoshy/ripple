"""核心 Agent Loop 实现

这是整个 Ripple 系统的核心，实现了类似 claude-code 的主循环逻辑。
"""

import json
import re
from typing import TYPE_CHECKING, Any, AsyncGenerator

from ripple.api.client import OpenRouterClient
from ripple.api.streaming import process_stream_response
from ripple.core.context import ToolUseContext
from ripple.core.state import QueryState
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
    create_tool_result_message,
    create_user_message,
    deserialize_message,
    extract_tool_use_blocks,
    normalize_messages_for_api,
)
from ripple.utils.logger import get_logger

if TYPE_CHECKING:
    from ripple.compact.auto_compact import AutoCompactor

logger = get_logger("core.agent_loop")

# context_length_exceeded 相关的错误关键字
_CONTEXT_TOO_LONG_KEYWORDS = [
    "context_length_exceeded",
    "prompt is too long",
    "maximum context length",
    "token limit",
    "request too large",
    "prompt_too_long",
    "input too long",
    "too many tokens",
]

# max_output_tokens 相关的错误关键字
_MAX_OUTPUT_KEYWORDS = [
    "max_output_tokens",
    "output token",
]

MAX_REACTIVE_COMPACT_RETRIES = 2

# 从 PTL 错误消息中提取 token 数值的正则
_PTL_TOKEN_PATTERN = re.compile(r"(\d[\d,]*)\s*tokens?\s*[>≥]\s*(\d[\d,]*)")
_PTL_CONTEXT_LENGTH_PATTERN = re.compile(r"maximum\s+(?:context\s+)?length\s+(?:is\s+)?(\d[\d,]*)")


def _parse_ptl_token_gap(error_str: str) -> int | None:
    """从 prompt-too-long 错误消息中提取 token 超额量

    支持的格式：
    - "137500 tokens > 135000 limit" → gap = 2500
    - "maximum context length is 200000 ... resulted in 210000 tokens" → gap = 10000

    Returns:
        token 超额量，无法解析时返回 None
    """
    # 模式 1: "X tokens > Y"
    match = _PTL_TOKEN_PATTERN.search(error_str)
    if match:
        actual = int(match.group(1).replace(",", ""))
        limit = int(match.group(2).replace(",", ""))
        if actual > limit:
            return actual - limit

    # 模式 2: "maximum context length is Y ... X tokens"
    limit_match = _PTL_CONTEXT_LENGTH_PATTERN.search(error_str)
    if limit_match:
        limit = int(limit_match.group(1).replace(",", ""))
        all_numbers = re.findall(r"(\d[\d,]*)\s*tokens?", error_str)
        for num_str in all_numbers:
            num = int(num_str.replace(",", ""))
            if num > limit:
                return num - limit

    return None


def _is_context_too_long_error(error_str: str) -> bool:
    """判断是否是上下文过长的错误"""
    return any(kw in error_str for kw in _CONTEXT_TOO_LONG_KEYWORDS)


def _is_max_output_error(error_str: str) -> bool:
    """判断是否是 max_output_tokens 错误"""
    return any(kw in error_str for kw in _MAX_OUTPUT_KEYWORDS)


def _extract_stop_metadata(stop_reason: str, tool_results: list[Message]) -> dict[str, str | list[str]]:
    """从工具结果中提取暂停元数据。"""
    if stop_reason != "ask_user":
        return {}

    for message in reversed(tool_results):
        if getattr(message, "type", None) != "user":
            continue

        for block in reversed(message.message.get("content", [])):
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue

            content = block.get("content", "")
            if not isinstance(content, str):
                continue

            try:
                payload = json.loads(content)
            except json.JSONDecodeError:
                continue

            if not isinstance(payload, dict) or "question" not in payload:
                continue

            options = payload.get("options")
            return {
                "question": str(payload.get("question", "")),
                "options": options if isinstance(options, list) else [],
            }

    return {}


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
        compactor: "AutoCompactor | None" = None,
    ):
        self.messages = messages
        self.tool_use_context = tool_use_context
        self.model = model
        self.max_turns = max_turns
        self.max_tokens = max_tokens
        self.thinking = thinking
        self.compactor = compactor


async def query_loop(
    params: QueryParams,
    client: OpenRouterClient,
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

    executed_tool_keys: set[str] = set()

    from ripple.compact.auto_compact import AutoCompactor
    from ripple.recovery.error_recovery import ErrorRecovery

    compactor = params.compactor or AutoCompactor()
    recovery = ErrorRecovery()
    reactive_compact_count = 0
    last_microcompact_msg_count: int = 0

    while True:
        # ========== 阶段 0: 检查是否已被中止 ==========
        if state.tool_use_context.abort_signal and state.tool_use_context.abort_signal.is_aborted:
            logger.info("Turn {}: 检测到 abort signal，终止循环", state.turn_count)
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
                        logger.info("检测到工具调用: {}", tu.get("name", "unknown"))
                        streaming_executor.add_tool(tu, item)

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

            error_str = str(e).lower()

            # 检查是否是上下文过长的错误 → reactive compact
            if _is_context_too_long_error(error_str):
                if reactive_compact_count < MAX_REACTIVE_COMPACT_RETRIES:
                    reactive_compact_count += 1

                    # 尝试从错误消息中解析精确的 token 超额量
                    token_gap = _parse_ptl_token_gap(error_str)

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
                    state = state.with_transition(TerminalPromptTooLong())
                    return

            # 检查是否是 max_output_tokens 错误
            if _is_max_output_error(error_str):
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
                        logger.warning("升级后达到最大轮数 {}，终止循环", params.max_turns)
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
                        logger.warning("恢复后达到最大轮数 {}，终止循环", params.max_turns)
                        state = state.with_transition(TerminalMaxTurns(turn_count=state.turn_count))
                        return
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
                        loop_stop_reason = loop_stop_reason or update.stop_reason
                        if update.stop_metadata and not loop_stop_metadata:
                            loop_stop_metadata = update.stop_metadata

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
            logger.info(
                "Turn {}: 工具请求暂停 agent loop（reason={}）",
                state.turn_count,
                loop_stop_reason or "unknown",
            )
            yield AgentStopEvent(
                stop_reason=loop_stop_reason or "tool_requested",
                metadata=loop_stop_metadata
                or _extract_stop_metadata(loop_stop_reason or "tool_requested", tool_results),
            )
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
    """准备工具定义用于 API 调用"""
    tools = []
    for tool in context.options.tools:
        if hasattr(tool, "to_openai_tool"):
            tools.append(tool.to_openai_tool())
    return tools


async def _handle_stop_hooks(
    messages: list[Message],
    assistant_messages: list[AssistantMessage],
    context: ToolUseContext,
):
    """处理 Stop Hooks"""
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
    compactor: "AutoCompactor | None" = None,
) -> AsyncGenerator[Message | StreamEvent | RequestStartEvent | AgentStopEvent, None]:
    """查询入口函数"""
    if client is None:
        client = OpenRouterClient()

    messages = []

    from datetime import datetime

    from ripple.messages.utils import create_system_message

    if system_prompt:
        messages.append(create_system_message(content=system_prompt))
    else:
        current_date = datetime.now().strftime("%Y/%m/%d")
        from ripple.utils.paths import CLI_WORKSPACE_DIR

        workspace_dir = CLI_WORKSPACE_DIR
        messages.append(
            create_system_message(
                content=(
                    f"Today's date is {current_date}. Use this date when searching for current information or answering time-sensitive questions.\n\n"
                    f"When writing or saving files, use `{workspace_dir}` as the default output directory. "
                    f"Do NOT write to the user's home directory, root directory, or any system directory."
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
    )

    async for item in query_loop(params, client):
        yield item
