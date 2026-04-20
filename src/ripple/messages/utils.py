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
from ripple.utils.logger import get_logger

logger = get_logger("messages.utils")


def create_user_message(
    content: str | list[dict[str, Any]],
    is_meta: bool = False,
    source_tool_assistant_uuid: str | None = None,
    tool_use_result: str | None = None,
    is_compact_boundary: bool = False,
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


def normalize_messages_for_api(
    messages: list[Message | dict[str, Any]],
) -> list[dict[str, Any]]:
    """规范化消息用于 API 调用

    将内部 Anthropic 风格的消息（tool_use / tool_result content blocks）
    转换为 OpenAI 标准格式（tool_calls 字段 + role:"tool" 消息），
    确保与 OpenAI SDK / OpenRouter 兼容。

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
            if isinstance(msg, dict):
                continue

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


def normalize_messages_for_anthropic(
    messages: list[Message | dict[str, Any]],
) -> tuple[str | None, list[dict[str, Any]]]:
    """规范化消息用于 Anthropic Messages API 调用

    Anthropic API 要求：
    - `system` 是顶层独立参数（不是消息角色）
    - `messages` 仅允许 `user` / `assistant` 两种 role
    - content 使用 block 数组：`text` / `tool_use` / `tool_result`

    本函数把内部 `SystemMessage` 合并成一个 system prompt（多个按顺序用换行拼接），
    把 `UserMessage`/`AssistantMessage` 的内部 content blocks 原样透传
    （内部格式本来就是 Anthropic 风格的）。

    Args:
        messages: 消息列表（Message 对象或已序列化的 dict）

    Returns:
        (system_prompt, messages) 元组；system_prompt 为 None 表示没有 system
    """
    system_parts: list[str] = []
    normalized: list[dict[str, Any]] = []

    for msg in messages:
        if isinstance(msg, dict):
            if "role" in msg and "type" not in msg:
                role = msg.get("role")
                content = msg.get("content")
                if role == "system":
                    if isinstance(content, str):
                        system_parts.append(content)
                    continue
                if role in ("user", "assistant"):
                    normalized.append({"role": role, "content": _to_anthropic_content(content)})
                continue
            msg = deserialize_message(msg)
            if isinstance(msg, dict):
                continue

        if msg.type == "user" and msg.is_meta:
            continue

        if msg.type == "system":
            system_parts.append(msg.content)
            continue

        if msg.type in ("progress", "attachment"):
            continue

        if msg.type == "assistant":
            content_blocks = msg.message.get("content", [])
            normalized.append({"role": "assistant", "content": _clean_anthropic_blocks(content_blocks)})

        elif msg.type == "user":
            content_blocks = msg.message.get("content", [])
            normalized.append({"role": "user", "content": _clean_anthropic_blocks(content_blocks)})

    system = "\n\n".join(p for p in system_parts if p).strip() or None
    return system, normalized


def _to_anthropic_content(content: Any) -> list[dict[str, Any]]:
    """把 raw content（字符串或 block 列表）规范为 Anthropic content blocks"""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return _clean_anthropic_blocks(content)
    return [{"type": "text", "text": str(content)}]


def _clean_anthropic_blocks(blocks: list[Any]) -> list[dict[str, Any]]:
    """清洗 content blocks，只保留 Anthropic 认可的字段"""
    cleaned: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            cleaned.append({"type": "text", "text": block.get("text", "")})
        elif btype == "tool_use":
            cleaned.append(
                {
                    "type": "tool_use",
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "input": block.get("input", {}) or {},
                }
            )
        elif btype == "tool_result":
            entry: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": block.get("tool_use_id", ""),
                "content": block.get("content", ""),
            }
            if block.get("is_error"):
                entry["is_error"] = True
            cleaned.append(entry)
    return cleaned


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
