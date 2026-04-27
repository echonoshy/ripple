"""工具编排

实现工具的并发和串行执行逻辑。
"""

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator

from pydantic import BaseModel

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message
from ripple.messages.utils import create_tool_result_message
from ripple.sandbox.bilibili_gate import GATE_ALLOWED_TOOLS, gate_status
from ripple.utils.logger import get_logger

logger = get_logger("tools.orchestration")

# 工具结果落盘到 ripple.log 的上限（完整结果仍写入 messages.jsonl）
LOG_TRUNCATE_LEN = 500


def _truncate(text: str, max_len: int = LOG_TRUNCATE_LEN) -> str:
    """截断文本用于日志输出"""
    if len(text) <= max_len:
        return text
    return text[:max_len] + f"...[+{len(text) - max_len} chars]"


def _fmt_kv(summary: dict[str, Any]) -> str:
    """把 {"k1": v1, "k2": v2} 格式化成 "k1=v1 k2=v2"，便于 grep

    值里有空格时会加双引号。None 会被渲染成 ``null``。
    """
    if not summary:
        return "-"
    parts: list[str] = []
    for key, value in summary.items():
        if value is None:
            rendered = "null"
        elif isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, (int, float)):
            rendered = str(value)
        elif isinstance(value, str):
            rendered = value
        else:
            try:
                rendered = json.dumps(value, ensure_ascii=False)
            except (TypeError, ValueError):
                rendered = str(value)
        if any(ch in rendered for ch in (" ", "\t", "\n", '"')):
            rendered = '"' + rendered.replace('"', '\\"').replace("\n", "\\n") + '"'
        parts.append(f"{key}={rendered}")
    return " ".join(parts)


@dataclass
class MessageUpdate:
    """消息更新"""

    message: Message | None = None
    new_context: ToolUseContext | None = None
    stop_agent_loop: bool = False
    stop_reason: str | None = None
    stop_metadata: dict[str, Any] | None = None


def _dedup_tool_calls(
    tool_use_blocks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """对相同 name + input 的工具调用去重，只保留第一个。

    Returns:
        (unique_blocks, duplicate_blocks)
    """
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []

    for block in tool_use_blocks:
        key = json.dumps({"name": block.get("name"), "input": block.get("input", {})}, sort_keys=True)
        if key in seen:
            duplicates.append(block)
        else:
            seen.add(key)
            unique.append(block)

    return unique, duplicates


async def run_tools(
    tool_use_blocks: list[dict[str, Any]],
    assistant_messages: list[AssistantMessage],
    tool_use_context: ToolUseContext,
) -> AsyncGenerator[MessageUpdate, None]:
    """执行工具调用

    Args:
        tool_use_blocks: 工具调用块列表
        assistant_messages: 助手消息列表
        tool_use_context: 工具使用上下文

    Yields:
        消息更新
    """
    current_context = tool_use_context

    unique_blocks, duplicate_blocks = _dedup_tool_calls(tool_use_blocks)

    for dup in duplicate_blocks:
        parent_message = _find_parent_message(dup, assistant_messages)
        msg = create_tool_result_message(
            tool_use_id=dup["id"],
            content="Duplicate tool call skipped — same tool was already called with identical arguments.",
            is_error=False,
            source_assistant_uuid=parent_message.uuid if parent_message else None,
        )
        yield MessageUpdate(message=msg)

    # 分区：并发安全 vs 串行
    batches = _partition_tool_calls(unique_blocks, current_context)

    for batch in batches:
        if batch["is_concurrency_safe"]:
            # 并发执行
            async for update in _run_tools_concurrently(
                batch["blocks"],
                assistant_messages,
                current_context,
            ):
                yield update
        else:
            # 串行执行
            async for update in _run_tools_serially(
                batch["blocks"],
                assistant_messages,
                current_context,
            ):
                if update.new_context:
                    current_context = update.new_context
                yield update


def _partition_tool_calls(
    tool_use_blocks: list[dict[str, Any]],
    context: ToolUseContext,
) -> list[dict[str, Any]]:
    """将工具调用分区为可并发执行的批次

    Args:
        tool_use_blocks: 工具调用块列表
        context: 工具使用上下文

    Returns:
        批次列表
    """
    batches = []

    for tool_use in tool_use_blocks:
        tool = find_tool_by_name(context.options.tools, tool_use["name"])

        # 检查并发安全性
        is_safe = False
        if tool:
            try:
                is_safe = tool.is_concurrency_safe(tool_use.get("input", {}))
            except Exception:
                # 保守策略：异常时视为不安全
                is_safe = False

        # 分区逻辑
        if is_safe and batches and batches[-1]["is_concurrency_safe"]:
            # 合并到上一个安全批次
            batches[-1]["blocks"].append(tool_use)
        else:
            # 创建新批次
            batches.append(
                {
                    "is_concurrency_safe": is_safe,
                    "blocks": [tool_use],
                }
            )

    return batches


async def _run_tools_serially(
    tool_use_blocks: list[dict[str, Any]],
    assistant_messages: list[AssistantMessage],
    context: ToolUseContext,
) -> AsyncGenerator[MessageUpdate, None]:
    """串行执行工具

    Args:
        tool_use_blocks: 工具调用块列表
        assistant_messages: 助手消息列表
        context: 工具使用上下文

    Yields:
        消息更新
    """
    current_context = context

    for tool_use in tool_use_blocks:
        # 找到对应的助手消息
        parent_message = _find_parent_message(tool_use, assistant_messages)

        # 执行工具
        async for update in execute_tool(tool_use, parent_message, current_context):
            if update.new_context:
                current_context = update.new_context
            yield update


async def _run_tools_concurrently(
    tool_use_blocks: list[dict[str, Any]],
    assistant_messages: list[AssistantMessage],
    context: ToolUseContext,
) -> AsyncGenerator[MessageUpdate, None]:
    """并发执行工具

    Args:
        tool_use_blocks: 工具调用块列表
        assistant_messages: 助手消息列表
        context: 工具使用上下文

    Yields:
        消息更新
    """
    tasks = []
    for tool_use in tool_use_blocks:
        parent_message = _find_parent_message(tool_use, assistant_messages)
        task = _execute_tool_collect(tool_use, parent_message, context)
        tasks.append((tool_use, task))

    gathered = await asyncio.gather(*[t for _, t in tasks], return_exceptions=True)

    for (tool_use, _), result in zip(tasks, gathered):
        if isinstance(result, Exception):
            from ripple.utils.errors import error_message

            t_name = tool_use.get("name", "?")
            logger.opt(exception=result).error("并发工具执行异常: {}", t_name)
            error_msg = create_tool_result_message(
                tool_use_id=tool_use.get("id", ""),
                content=f"Tool execution failed: {error_message(result)}",
                is_error=True,
                tool_name=t_name,
            )
            yield MessageUpdate(message=error_msg)
        else:
            for update in result:
                yield update


async def execute_tool(
    tool_use: dict[str, Any],
    parent_message: AssistantMessage | None,
    context: ToolUseContext,
) -> AsyncGenerator[MessageUpdate, None]:
    """执行单个工具

    Args:
        tool_use: 工具调用块
        parent_message: 父助手消息（可能为 None）
        context: 工具使用上下文

    Yields:
        消息更新
    """
    tool_name = tool_use.get("name", "unknown")
    tool_input = tool_use.get("input", {})
    tool = find_tool_by_name(context.options.tools, tool_name)
    parent_uuid = parent_message.uuid if parent_message else None

    if tool_use.get("_args_parse_error"):
        raw_args = tool_use["_args_parse_error"]
        logger.warning("工具参数损坏，跳过执行: {} | raw: {}", tool_name, raw_args)
        error_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=f"Tool arguments could not be parsed (corrupted JSON). Raw: {raw_args}",
            is_error=True,
            tool_name=tool_name,
            source_assistant_uuid=parent_uuid,
        )
        yield MessageUpdate(message=error_msg)
        return

    if tool:
        try:
            input_summary = tool.log_input_summary(tool_input)
        except Exception:
            # 摘要钩子若异常，退回到 keys-only，永不因日志钩子拖垮主流程
            input_summary = {"keys": sorted(tool_input.keys()) if isinstance(tool_input, dict) else []}
    else:
        input_summary = {"keys": sorted(tool_input.keys()) if isinstance(tool_input, dict) else []}
    logger.info("event=tool.call.start tool={} {}", tool_name, _fmt_kv(input_summary))

    if not tool:
        logger.warning("工具未找到: {}", tool_name)
        error_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=f"Tool '{tool_name}' not found",
            is_error=True,
            tool_name=tool_name,
            source_assistant_uuid=parent_uuid,
        )
        yield MessageUpdate(message=error_msg)
        return

    # ── Bilibili 扫码互斥闸门 ──
    # 当 BilibiliLoginStart 已发过二维码、但 BilibiliLoginPoll 尚未回收 terminal
    # state（也没被 Logout 显式取消）时，本 user 不允许跑任何非扫码相关工具——
    # 防 agent 在用户还在扫码时抢跑 extract / Bash / Write 等，把还没落盘的凭证
    # 当 'need_sessdata' 错用。
    if context.user_id and tool_name not in GATE_ALLOWED_TOOLS:
        pending = gate_status(context.user_id)
        if pending is not None:
            elapsed = pending.elapsed()
            gate_error = (
                "Blocked by BilibiliAuthGate: 当前 user 的 B 站扫码登录还在进行中"
                f"（qrcode_key={pending.qrcode_key[:8]}..., 已等 {elapsed:.0f}s）。\n"
                "两段式扫码登录尚未收尾，你 **必须** 先处理完扫码再做别的事：\n"
                "  1. **如果用户最近一句是『好了 / 扫好了 / ok / done / 点了确认登录』**——"
                f"他刚扫完 + 点完确认：调 `BilibiliLoginPoll(qrcode_key='{pending.qrcode_key}')` "
                "拿凭证（默认 30s 短等待，B 站侧状态通常秒返回 ok）。\n"
                "  2. **如果 poll 上一轮返回 state=pending**：说明用户还没真正扫完/没点确认；"
                "先耐心回复用户提示他完成扫码动作，**结束本 turn**，等他回话再 poll。"
                "**不要**在当前 turn 直接再 poll，也不要硬拉其他工具尝试绕过。\n"
                "  3. **如果用户明确放弃**（『算了 / 不登录了 / 取消』）：调 `BilibiliLogout` "
                "解除闸门，然后按用户意图继续（或走降级路径）。\n"
                "  4. **如果二维码已过期**或用户抱怨无法打开：调 `BilibiliLoginStart` 重新"
                "生成（会覆盖旧的 key）。\n"
                f"扫码窗口期内 `{tool_name}` 等非扫码工具一律被拒绝——这是硬互斥，"
                "不要再用其他 tool call 尝试绕过。"
            )
            logger.warning(
                "工具被 bilibili 扫码闸门拦截: {} | user={} elapsed={:.1f}s",
                tool_name,
                context.user_id,
                elapsed,
            )
            blocked_msg = create_tool_result_message(
                tool_use_id=tool_use["id"],
                content=gate_error,
                is_error=True,
                tool_name=tool_name,
                source_assistant_uuid=parent_uuid,
            )
            yield MessageUpdate(message=blocked_msg)
            return

    if hasattr(context, "permission_manager") and context.permission_manager:
        allowed, reason, permission_request = await context.permission_manager.check_permission(
            tool, tool_input, context
        )

        if not allowed:
            if permission_request is not None:
                permission_request = {
                    **permission_request,
                    "tool_use_id": tool_use["id"],
                    "source_assistant_uuid": parent_uuid,
                }
                permission_msg = create_tool_result_message(
                    tool_use_id=tool_use["id"],
                    content=(
                        f"Awaiting user permission for {tool_name}. "
                        "The request has been shown to the user and execution is paused."
                    ),
                    is_error=False,
                    tool_name=tool_name,
                    source_assistant_uuid=parent_uuid,
                )
                yield MessageUpdate(
                    message=permission_msg,
                    stop_agent_loop=True,
                    stop_reason="permission_request",
                    stop_metadata=permission_request,
                )
                return

            logger.warning("工具权限拒绝: {} | 原因: {}", tool_name, reason)
            error_msg = create_tool_result_message(
                tool_use_id=tool_use["id"],
                content=f"Permission denied: {reason}",
                is_error=True,
                tool_name=tool_name,
                source_assistant_uuid=parent_uuid,
            )
            yield MessageUpdate(message=error_msg)
            return

    t0 = time.monotonic()
    try:
        result = await tool.call(
            args=tool_input,
            context=context,
            parent_message=parent_message,
        )
        elapsed = time.monotonic() - t0

        if isinstance(result.data, BaseModel):
            result_content = result.data.model_dump_json()
        else:
            result_content = str(result.data)
        if len(result_content) > tool.max_result_size_chars:
            result_content = result_content[: tool.max_result_size_chars] + "\n... [truncated]"

        try:
            result_summary = tool.log_result_summary(result.data)
        except Exception:
            result_summary = {"bytes": len(result_content)}
        logger.info(
            "event=tool.call.end tool={} duration_ms={:.0f} {}",
            tool_name,
            elapsed * 1000.0,
            _fmt_kv(result_summary),
        )

        result_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=result_content,
            is_error=False,
            tool_name=tool_name,
            source_assistant_uuid=parent_uuid,
        )
        yield MessageUpdate(
            message=result_msg,
            stop_agent_loop=result.stop_agent_loop,
            stop_reason=result.stop_reason,
        )

        if result.new_messages:
            for msg in result.new_messages:
                yield MessageUpdate(message=msg)

        if result.context_modifier:
            new_context = result.context_modifier(context)
            yield MessageUpdate(new_context=new_context)

    except Exception as e:
        elapsed = time.monotonic() - t0
        from ripple.utils.errors import error_message

        err = error_message(e)
        logger.warning(
            "event=tool.call.error tool={} duration_ms={:.0f} error={}",
            tool_name,
            elapsed * 1000.0,
            err,
        )

        error_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=f"Tool execution failed: {err}",
            is_error=True,
            tool_name=tool_name,
            source_assistant_uuid=parent_uuid,
        )
        yield MessageUpdate(message=error_msg)


async def _execute_tool_collect(
    tool_use: dict[str, Any],
    parent_message: AssistantMessage | None,
    context: ToolUseContext,
) -> list[MessageUpdate]:
    """执行工具并收集所有更新

    Args:
        tool_use: 工具调用块
        parent_message: 父助手消息
        context: 工具使用上下文

    Returns:
        消息更新列表
    """
    updates = []
    async for update in execute_tool(tool_use, parent_message, context):
        updates.append(update)
    return updates


def find_tool_by_name(tools: list[Any], name: str) -> Any:
    """根据名称查找工具

    Args:
        tools: 工具列表
        name: 工具名称

    Returns:
        工具对象或 None
    """
    for tool in tools:
        if tool.name == name:
            return tool
    return None


def _find_parent_message(
    tool_use: dict[str, Any],
    assistant_messages: list[AssistantMessage],
) -> AssistantMessage | None:
    """查找包含工具调用的助手消息

    Args:
        tool_use: 工具调用块
        assistant_messages: 助手消息列表

    Returns:
        父助手消息，找不到时返回 None
    """
    tool_use_id = tool_use["id"]

    for msg in assistant_messages:
        for block in msg.message.get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") == tool_use_id:
                return msg

    # 如果找不到，返回最后一条助手消息
    return assistant_messages[-1] if assistant_messages else None
