"""Token 计数和估算

提供消息的 token 计数功能。
"""

from typing import Any

from ripple.messages.types import Message
from ripple.utils.logger import get_logger

logger = get_logger("utils.token_counter")


def estimate_tokens(text: str) -> int:
    """快速估算文本的 token 数量

    使用简单的启发式规则：1 token ≈ 4 字符

    Args:
        text: 要估算的文本

    Returns:
        估算的 token 数量
    """
    return len(text) // 4


def estimate_message_tokens(message: Message) -> int:
    """估算单条消息的 token 数量

    Args:
        message: 消息对象

    Returns:
        估算的 token 数量
    """
    total = 0

    if message.type == "user":
        content = message.message.get("content", "")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        total += estimate_tokens(block.get("text", ""))
                    elif block.get("type") == "tool_result":
                        content_val = block.get("content", "")
                        if isinstance(content_val, str):
                            total += estimate_tokens(content_val)

    elif message.type == "assistant":
        content = message.message.get("content", [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        total += estimate_tokens(block.get("text", ""))
                    elif block.get("type") == "tool_use":
                        # 工具调用的参数
                        import json

                        input_data = block.get("input", {})
                        total += estimate_tokens(json.dumps(input_data))

    elif message.type == "system":
        content = message.content
        if isinstance(content, str):
            total += estimate_tokens(content)

    return total


def estimate_messages_tokens(messages: list[Message]) -> int:
    """估算消息列表的总 token 数量

    Args:
        messages: 消息列表

    Returns:
        估算的总 token 数量
    """
    return sum(estimate_message_tokens(msg) for msg in messages)


def get_actual_tokens_from_usage(usage: dict[str, Any] | None) -> int:
    """从 API 返回的 usage 中获取实际的 token 数量

    Args:
        usage: API 返回的 usage 字典

    Returns:
        实际的 token 数量
    """
    if not usage:
        return 0

    # 计算总输入 tokens
    input_tokens = usage.get("input_tokens", 0)
    cache_read = usage.get("cache_read_input_tokens", 0)
    cache_creation = usage.get("cache_creation_input_tokens", 0)

    return input_tokens + cache_read + cache_creation
