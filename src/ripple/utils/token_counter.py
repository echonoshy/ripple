"""Token 计数和估算

统一使用 tiktoken 编码器（cl100k_base）。
支持接收 API 返回的真实 token 数来校准。
"""

import json

import tiktoken

from ripple.messages.types import Message
from ripple.utils.logger import get_logger

logger = get_logger("utils.token_counter")

_encoding: tiktoken.Encoding | None = None


def _get_encoding() -> tiktoken.Encoding:
    """延迟加载 tiktoken 编码器"""
    global _encoding
    if _encoding is None:
        _encoding = tiktoken.get_encoding("cl100k_base")
    return _encoding


def estimate_tokens(text: str) -> int:
    """使用 tiktoken 估算文本的 token 数量"""
    if not text:
        return 0
    enc = _get_encoding()
    return len(enc.encode(text))


def estimate_message_tokens(message: Message) -> int:
    """估算单条 Message 对象的 token 数量"""
    if isinstance(message, dict):
        from ripple.messages.cleanup import estimate_tokens as _est_dict_tokens

        return _est_dict_tokens([message])

    total = 4  # per-message overhead

    if message.type == "user":
        content = message.message.get("content", "")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    total += estimate_tokens(block.get("text", ""))
                elif btype == "tool_result":
                    val = block.get("content", "")
                    if isinstance(val, str):
                        total += estimate_tokens(val)

    elif message.type == "assistant":
        content = message.message.get("content", [])
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    total += estimate_tokens(block.get("text", ""))
                elif btype == "tool_use":
                    total += estimate_tokens(block.get("name", ""))
                    input_data = block.get("input", {})
                    total += estimate_tokens(json.dumps(input_data, ensure_ascii=False))
                elif btype == "thinking":
                    total += estimate_tokens(block.get("thinking", ""))

    elif message.type == "system":
        content = message.content
        if isinstance(content, str):
            total += estimate_tokens(content)

    return total


def estimate_messages_tokens(messages: list[Message]) -> int:
    """估算消息列表的总 token 数量"""
    return sum(estimate_message_tokens(msg) for msg in messages)


def get_actual_tokens_from_usage(usage: dict | None) -> int:
    """从 API 返回的 usage 中获取实际的输入 token 数量"""
    if not usage:
        return 0
    input_tokens = usage.get("input_tokens", 0)
    cache_read = usage.get("cache_read_input_tokens", 0)
    cache_creation = usage.get("cache_creation_input_tokens", 0)
    return input_tokens + cache_read + cache_creation
