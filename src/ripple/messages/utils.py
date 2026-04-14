"""消息工具函数"""

import json
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


def create_user_message(
    content: str | list[dict[str, Any]],
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
    )


def create_system_message(content: str, level: str = "info") -> SystemMessage:
    """创建系统消息"""
    return SystemMessage(type="system", content=content, level=level)


def serialize_message(message: Message | dict[str, Any]) -> dict[str, Any]:
    """将内部消息对象转换为可持久化的 dict。"""
    if isinstance(message, dict):
        return message
    return message.model_dump()


def serialize_messages(messages: list[Message | dict[str, Any]]) -> list[dict[str, Any]]:
    """批量序列化消息列表。"""
    return [serialize_message(message) for message in messages]


def deserialize_message(data: dict[str, Any]) -> Message:
    """将持久化/兼容格式的 dict 转回内部消息对象。"""
    if "type" in data:
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

    role = data.get("role", "")

    if role == "system":
        return SystemMessage(type="system", content=data.get("content", ""))

    if role == "assistant":
        content = data.get("content", "")
        blocks: list[dict[str, Any]] = []
        if isinstance(content, str) and content:
            blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            blocks = list(content)

        for tool_call in data.get("tool_calls", []):
            function_data = tool_call.get("function", {})
            arguments_raw = function_data.get("arguments", "{}")
            try:
                tool_input = json.loads(arguments_raw) if isinstance(arguments_raw, str) else arguments_raw
            except (json.JSONDecodeError, TypeError):
                tool_input = {}

            blocks.append(
                {
                    "type": "tool_use",
                    "id": tool_call.get("id", ""),
                    "name": function_data.get("name", ""),
                    "input": tool_input,
                }
            )

        usage = data.get("usage", {})
        if not isinstance(usage, dict):
            usage = {}

        return AssistantMessage(
            type="assistant",
            message={
                "id": data.get("id", str(uuid4())),
                "content": blocks,
                "usage": usage,
            },
            uuid=data.get("uuid", str(uuid4())),
        )

    if role == "tool":
        return UserMessage(
            type="user",
            message={
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": data.get("tool_call_id", ""),
                        "content": data.get("content", ""),
                    }
                ]
            },
        )

    content = data.get("content", [])
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    return UserMessage(type="user", message={"content": content})


def normalize_messages_for_api(
    messages: list[Message | dict[str, Any]],
) -> list[dict[str, Any]]:
    """规范化消息用于 API 调用

    将内部 Anthropic 风格的消息（tool_use / tool_result content blocks）
    转换为 OpenAI 标准格式（tool_calls 字段 + role:"tool" 消息），
    确保与 OpenAI SDK / LiteLLM / OpenRouter 兼容。

    Args:
        messages: 消息列表（可以是 Message 对象或字典）

    Returns:
        规范化后的消息列表
    """
    normalized = []

    for msg in messages:
        if isinstance(msg, dict):
            if "role" in msg:
                normalized.append(msg)
                continue
            msg = deserialize_message(msg)

        if msg.type == "user" and msg.is_meta:
            continue

        if msg.type == "system":
            normalized.append({"role": "system", "content": msg.content})
            continue

        if msg.type in ("progress", "attachment"):
            continue

        if msg.type == "assistant":
            content = msg.message["content"]
            normalized.append(_convert_assistant_message(content))

        elif msg.type == "user":
            content = msg.message["content"]
            tool_result_blocks = [
                block for block in content if isinstance(block, dict) and block.get("type") == "tool_result"
            ]
            other_blocks = [
                block for block in content if not (isinstance(block, dict) and block.get("type") == "tool_result")
            ]

            if other_blocks:
                normalized.append({"role": "user", "content": other_blocks})

            for block in tool_result_blocks:
                normalized.append(
                    {
                        "role": "tool",
                        "tool_call_id": block.get("tool_use_id", ""),
                        "content": block.get("content", ""),
                    }
                )

            if not tool_result_blocks and not other_blocks:
                normalized.append({"role": "user", "content": content})

    return normalized


def _convert_assistant_message(content: list[dict[str, Any]]) -> dict[str, Any]:
    """将 Anthropic 风格的 assistant content blocks 转为 OpenAI 格式

    Anthropic 格式:
      content: [{"type":"text","text":"..."}, {"type":"tool_use","id":"...","name":"...","input":{...}}]

    OpenAI 格式:
      {"role":"assistant", "content":"...", "tool_calls":[{"id":"...","type":"function","function":{...}}]}
    """
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []

    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            tool_calls.append(
                {
                    "id": block.get("id", str(uuid4())),
                    "type": "function",
                    "function": {
                        "name": block.get("name", ""),
                        "arguments": json.dumps(block.get("input", {}), ensure_ascii=False),
                    },
                }
            )

    assistant_msg: dict[str, Any] = {"role": "assistant"}
    assistant_msg["content"] = "\n".join(text_parts) if text_parts else None

    if tool_calls:
        assistant_msg["tool_calls"] = tool_calls

    return assistant_msg


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
