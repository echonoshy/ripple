"""消息工具函数"""

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ripple.messages.types import (
    AssistantMessage,
    AttachmentMessage,
    Message,
    ProgressMessage,
    SystemMessage,
    UserMessage,
)
from ripple.utils.logger import get_logger

logger = get_logger("messages.utils")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_user_message(
    content: str | list[dict[str, Any]],
    is_meta: bool = False,
    source_tool_assistant_uuid: str | None = None,
    tool_use_result: str | None = None,
    is_compact_boundary: bool = False,
    created_at: str | None = None,
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
        is_compact_boundary=is_compact_boundary,
        created_at=created_at or _utc_now_iso(),
    )


def create_assistant_message(
    content: list[dict[str, Any]],
    message_id: str | None = None,
    usage: dict[str, int] | None = None,
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
        created_at=_utc_now_iso(),
    )


def create_system_message(content: str, level: str = "info") -> SystemMessage:
    """创建系统消息"""
    return SystemMessage(type="system", content=content, level=level, created_at=_utc_now_iso())


def serialize_message(message: Message | dict[str, Any]) -> dict[str, Any]:
    """将内部消息对象转换为可持久化的 dict。"""
    if isinstance(message, dict):
        if "type" not in message:
            logger.warning("序列化消息缺少 type 字段，可能是 OpenAI 格式混入: {}", list(message.keys()))
        return message
    return message.model_dump()


def serialize_messages(messages: list[Message | dict[str, Any]]) -> list[dict[str, Any]]:
    """批量序列化消息列表。"""
    return [serialize_message(message) for message in messages]


def deserialize_message(data: dict[str, Any]) -> Message | dict[str, Any]:
    """将持久化 dict 转回内部消息对象。

    仅支持内部格式（type 字段分派）。无法识别的格式原样返回并打印 warning。
    """
    message_type = data.get("type")

    if message_type == "assistant":
        return AssistantMessage.model_validate(data)
    if message_type == "user":
        return UserMessage.model_validate(data)
    if message_type == "system":
        return SystemMessage.model_validate(data)
    if message_type == "progress":
        return ProgressMessage.model_validate(data)
    if message_type == "attachment":
        return AttachmentMessage.model_validate(data)

    logger.warning("无法识别的消息格式 (keys={}), 原样保留", list(data.keys()))
    return data


def extract_tool_use_blocks(message: AssistantMessage) -> list[dict[str, Any]]:
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
    tool_name: str | None = None,
    source_assistant_uuid: str | None = None,
) -> UserMessage:
    """创建工具结果消息"""
    block: dict[str, Any] = {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
        "is_error": is_error,
    }
    if tool_name:
        block["tool_name"] = tool_name
    return create_user_message(
        content=[block],
        source_tool_assistant_uuid=source_assistant_uuid,
    )
