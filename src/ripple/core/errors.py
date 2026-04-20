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

# 可重试的连接类错误关键字（与 SDK 原生重试互补，覆盖 SDK 无法自动续的流中断场景）
# 注意：仅对"本轮尚未产出任何 AssistantMessage"时生效，否则会污染消息历史
_RETRYABLE_CONNECTION_KEYWORDS = [
    "connection error",
    "connection reset",
    "connection aborted",
    "connection refused",
    "connection closed",
    "connecterror",
    "read timeout",
    "remote protocol error",
    "server disconnected",
    "apitimeouterror",
    "apiconnectionerror",
    # 可重试的 HTTP 状态码（字符串匹配）
    "status code: 429",
    "status code: 500",
    "status code: 502",
    "status code: 503",
    "status code: 504",
]

MAX_REACTIVE_COMPACT_RETRIES = 2

# 本轮"模型流建立失败"的最大重试次数（与 AsyncOpenAI.max_retries 叠加生效）
MAX_CONNECTION_RETRIES = 3

# 连接错误重试的指数退避基数（秒）：delay = BASE * 2^(attempt-1)
CONNECTION_RETRY_BACKOFF_BASE = 1.0

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


def is_retryable_connection_error(error_str: str) -> bool:
    """判断是否是可自动重试的连接/网络错误

    用于 agent_loop 对"流建立失败"或"可重试 5xx/429"做一层自己的指数退避重试，
    与 AsyncOpenAI SDK 自带的 max_retries 互补（SDK 只覆盖流建立之前）。

    调用方必须额外检查"本轮是否已产出 AssistantMessage"，已产出则不要重试，
    否则会出现重复消息污染历史。
    """
    # 主动排除不该重试的错误：认证/参数错误
    non_retryable = ["status code: 401", "status code: 403", "status code: 400", "status code: 404"]
    if any(kw in error_str for kw in non_retryable):
        return False

    return any(kw in error_str for kw in _RETRYABLE_CONNECTION_KEYWORDS)


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
