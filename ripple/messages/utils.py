"""消息工具函数"""

from typing import Any, Dict, List
from uuid import uuid4

from ripple.messages.types import (
    AssistantMessage,
    Message,
    SystemMessage,
    UserMessage,
)


def create_user_message(
    content: str | List[Dict[str, Any]],
    is_meta: bool = False,
    source_tool_assistant_uuid: str | None = None,
    tool_use_result: str | None = None,
) -> UserMessage:
    """创建用户消息"""
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]

    return UserMessage(
        type="user",
        message={"content": content},
        is_meta=is_meta,
        source_tool_assistant_uuid=source_tool_assistant_uuid,
        tool_use_result=tool_use_result,
    )


def create_assistant_message(
    content: List[Dict[str, Any]],
    message_id: str | None = None,
    usage: Dict[str, int] | None = None,
) -> AssistantMessage:
    """创建助手消息"""
    return AssistantMessage(
        type="assistant",
        message={
            "id": message_id or str(uuid4()),
            "content": content,
            "usage": usage or {},
        },
        uuid=str(uuid4()),
    )


def create_system_message(content: str, level: str = "info") -> SystemMessage:
    """创建系统消息"""
    return SystemMessage(type="system", content=content, level=level)


def normalize_messages_for_api(messages: List[Message]) -> List[Dict[str, Any]]:
    """规范化消息用于 API 调用

    - 移除 meta 消息
    - 移除 UI-only 消息
    - 转换为 API 格式
    """
    normalized = []

    for msg in messages:
        # 跳过 meta 消息
        if msg.type == "user" and msg.is_meta:
            continue

        # 跳过系统消息和进度消息
        if msg.type in ("system", "progress", "attachment"):
            continue

        # 转换为 API 格式
        if msg.type == "assistant":
            normalized.append({"role": "assistant", "content": msg.message["content"]})
        elif msg.type == "user":
            normalized.append({"role": "user", "content": msg.message["content"]})

    return normalized


def extract_tool_use_blocks(message: AssistantMessage) -> List[Dict[str, Any]]:
    """从助手消息中提取工具调用块"""
    tool_uses = []
    for block in message.message.get("content", []):
        if isinstance(block, dict) and block.get("type") == "tool_use":
            tool_uses.append(block)
    return tool_uses


def create_tool_result_message(
    tool_use_id: str,
    content: str,
    is_error: bool = False,
    source_assistant_uuid: str | None = None,
) -> UserMessage:
    """创建工具结果消息"""
    return create_user_message(
        content=[
            {
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            }
        ],
        source_tool_assistant_uuid=source_assistant_uuid,
    )
