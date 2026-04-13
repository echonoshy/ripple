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
from ripple.utils.logger import get_logger

logger = get_logger("tools.orchestration")

LOG_TRUNCATE_LEN = 500


def _truncate(text: str, max_len: int = LOG_TRUNCATE_LEN) -> str:
    """截断文本用于日志输出"""
    if len(text) <= max_len:
        return text
    return text[:max_len] + f"...[+{len(text) - max_len} chars]"


@dataclass
class MessageUpdate:
    """消息更新"""

    message: Message | None = None
    new_context: ToolUseContext | None = None
    stop_agent_loop: bool = False


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
            logger.error("并发工具执行异常: {}: {}", t_name, result)
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

    input_str = _truncate(json.dumps(tool_input, ensure_ascii=False))
    logger.info("工具调用: {} | 参数: {}", tool_name, input_str)

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

    if hasattr(context, "permission_manager") and context.permission_manager:
        allowed, reason = await context.permission_manager.check_permission(tool, tool_input, context)

        if not allowed:
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

        logger.info("工具完成: {} | 耗时: {:.2f}s | 结果: {}", tool_name, elapsed, _truncate(result_content))

        result_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=result_content,
            is_error=False,
            tool_name=tool_name,
            source_assistant_uuid=parent_uuid,
        )
        yield MessageUpdate(message=result_msg, stop_agent_loop=result.stop_agent_loop)

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
        logger.warning("工具失败: {} | 耗时: {:.2f}s | 错误: {}", tool_name, elapsed, err)

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
