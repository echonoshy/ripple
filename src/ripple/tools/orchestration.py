"""工具编排

实现工具的并发和串行执行逻辑。
"""

import asyncio
import json
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, List

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message
from ripple.messages.utils import create_tool_result_message


@dataclass
class MessageUpdate:
    """消息更新"""

    message: Message | None = None
    new_context: ToolUseContext | None = None


def _dedup_tool_calls(
    tool_use_blocks: List[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """对相同 name + input 的工具调用去重，只保留第一个。

    Returns:
        (unique_blocks, duplicate_blocks)
    """
    seen: set[str] = set()
    unique: list[Dict[str, Any]] = []
    duplicates: list[Dict[str, Any]] = []

    for block in tool_use_blocks:
        key = json.dumps({"name": block.get("name"), "input": block.get("input", {})}, sort_keys=True)
        if key in seen:
            duplicates.append(block)
        else:
            seen.add(key)
            unique.append(block)

    return unique, duplicates


async def run_tools(
    tool_use_blocks: List[Dict[str, Any]],
    assistant_messages: List[AssistantMessage],
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
    tool_use_blocks: List[Dict[str, Any]],
    context: ToolUseContext,
) -> List[Dict[str, Any]]:
    """将工具调用分区为可并发执行的批次

    Args:
        tool_use_blocks: 工具调用块列表
        context: 工具使用上下文

    Returns:
        批次列表
    """
    batches = []

    for tool_use in tool_use_blocks:
        tool = _find_tool_by_name(context.options.tools, tool_use["name"])

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
    tool_use_blocks: List[Dict[str, Any]],
    assistant_messages: List[AssistantMessage],
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
        async for update in _execute_tool(tool_use, parent_message, current_context):
            if update.new_context:
                current_context = update.new_context
            yield update


async def _run_tools_concurrently(
    tool_use_blocks: List[Dict[str, Any]],
    assistant_messages: List[AssistantMessage],
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
    # 创建所有工具执行任务
    tasks = []
    for tool_use in tool_use_blocks:
        parent_message = _find_parent_message(tool_use, assistant_messages)
        task = _execute_tool_collect(tool_use, parent_message, context)
        tasks.append(task)

    # 并发执行
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # 生成结果
    for result in results:
        if isinstance(result, Exception):
            # 错误处理
            continue
        for update in result:
            yield update


async def _execute_tool(
    tool_use: Dict[str, Any],
    parent_message: AssistantMessage,
    context: ToolUseContext,
) -> AsyncGenerator[MessageUpdate, None]:
    """执行单个工具

    Args:
        tool_use: 工具调用块
        parent_message: 父助手消息
        context: 工具使用上下文

    Yields:
        消息更新
    """
    tool = _find_tool_by_name(context.options.tools, tool_use["name"])

    if not tool:
        # 工具不存在
        error_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=f"Tool '{tool_use['name']}' not found",
            is_error=True,
            source_assistant_uuid=parent_message.uuid,
        )
        yield MessageUpdate(message=error_msg)
        return

    # ========== 权限检查 ==========
    if hasattr(context, "permission_manager") and context.permission_manager:
        allowed, reason = await context.permission_manager.check_permission(tool, tool_use.get("input", {}), context)

        if not allowed:
            error_msg = create_tool_result_message(
                tool_use_id=tool_use["id"],
                content=f"Permission denied: {reason}",
                is_error=True,
                source_assistant_uuid=parent_message.uuid,
            )
            yield MessageUpdate(message=error_msg)
            return

    try:
        # 调用工具
        result = await tool.call(
            args=tool_use.get("input", {}),
            context=context,
            parent_message=parent_message,
        )

        # 创建工具结果消息
        result_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=str(result.data),
            is_error=False,
            source_assistant_uuid=parent_message.uuid,
        )
        yield MessageUpdate(message=result_msg)

        # 注入工具产生的附加消息（如 Skill inline 模式的 prompt 注入）
        if result.new_messages:
            for msg in result.new_messages:
                yield MessageUpdate(message=msg)

        # 应用 context 修改器
        if result.context_modifier:
            new_context = result.context_modifier(context)
            yield MessageUpdate(new_context=new_context)

    except Exception as e:
        # 工具执行错误
        from ripple.utils.errors import error_message

        error_msg = create_tool_result_message(
            tool_use_id=tool_use["id"],
            content=f"Tool execution failed: {error_message(e)}",
            is_error=True,
            source_assistant_uuid=parent_message.uuid,
        )
        yield MessageUpdate(message=error_msg)


async def _execute_tool_collect(
    tool_use: Dict[str, Any],
    parent_message: AssistantMessage,
    context: ToolUseContext,
) -> List[MessageUpdate]:
    """执行工具并收集所有更新

    Args:
        tool_use: 工具调用块
        parent_message: 父助手消息
        context: 工具使用上下文

    Returns:
        消息更新列表
    """
    updates = []
    async for update in _execute_tool(tool_use, parent_message, context):
        updates.append(update)
    return updates


def _find_tool_by_name(tools: List[Any], name: str) -> Any:
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
    tool_use: Dict[str, Any],
    assistant_messages: List[AssistantMessage],
) -> AssistantMessage:
    """查找包含工具调用的助手消息

    Args:
        tool_use: 工具调用块
        assistant_messages: 助手消息列表

    Returns:
        父助手消息
    """
    tool_use_id = tool_use["id"]

    for msg in assistant_messages:
        for block in msg.message.get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") == tool_use_id:
                return msg

    # 如果找不到，返回最后一条助手消息
    return assistant_messages[-1] if assistant_messages else None
