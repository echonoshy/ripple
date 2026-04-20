"""Agent Loop 错误分类与元数据提取

识别并解析 LLM API 错误字符串（上下文过长、max_output_tokens、prompt_too_long
数值解析等），以及从工具结果中提取暂停元数据。所有识别均基于关键字匹配
而非异常类型 —— 不同 provider 抛出的异常结构差异很大，字符串匹配是最稳定的。
"""

import json
import re

from ripple.messages.types import Message

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


def parse_ptl_token_gap(error_str: str) -> int | None:
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


def is_context_too_long_error(error_str: str) -> bool:
    """判断是否是上下文过长的错误"""
    return any(kw in error_str for kw in _CONTEXT_TOO_LONG_KEYWORDS)


def is_max_output_error(error_str: str) -> bool:
    """判断是否是 max_output_tokens 错误"""
    return any(kw in error_str for kw in _MAX_OUTPUT_KEYWORDS)


def extract_stop_metadata(stop_reason: str, tool_results: list[Message]) -> dict[str, str | list[str]]:
    """从工具结果中提取 ask_user 暂停所需的元数据（question / options）"""
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
