"""消息清理工具

用于清理工具调用和结果，减少 token 消耗。
"""

import json
from typing import Any


def cleanup_tool_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """清理工具调用和结果，只保留对话摘要

    同时兼容两种消息格式，通过特征自动检测：

    OpenAI 格式特征:
    - assistant: content 为 str/None，工具调用在 tool_calls 字段
    - 工具结果: 独立的 role="tool" 消息

    Anthropic 格式特征:
    - assistant: content 为 list，包含 {"type":"tool_use"} block
    - 工具结果: 在 user 消息的 content 中，{"type":"tool_result"} block

    清理策略（两种格式统一）:
    - 只保留 assistant 的纯文本内容
    - 丢弃所有工具调用和工具结果

    Args:
        messages: 原始消息列表

    Returns:
        清理后的消息列表
    """
    cleaned = []

    for msg in messages:
        role = msg.get("role")

        # OpenAI 格式：独立的 tool 结果消息 → 丢弃
        if role == "tool":
            continue

        if role == "assistant":
            text = _extract_assistant_text(msg)
            if text:
                cleaned.append({"role": "assistant", "content": text})

        elif role == "user":
            content = msg.get("content", [])
            if isinstance(content, str):
                cleaned.append(msg)
            elif isinstance(content, list):
                # Anthropic 格式：过滤 tool_result block
                text_blocks = [
                    block for block in content if isinstance(block, dict) and block.get("type") != "tool_result"
                ]
                if text_blocks:
                    cleaned.append({"role": "user", "content": text_blocks})

        else:
            cleaned.append(msg)

    return cleaned


def _extract_assistant_text(msg: dict) -> str:
    """从 assistant 消息中提取纯文本，兼容 OpenAI / Anthropic 两种格式

    OpenAI: {"role":"assistant", "content":"text...", "tool_calls":[...]}
    Anthropic: {"role":"assistant", "content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}
    """
    content = msg.get("content")

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip()
        ]
        return "\n".join(parts)

    return ""


def estimate_tokens(messages: list[dict[str, Any]]) -> int:
    """估算消息列表的 token 数

    简单实现：字符数 / 4

    Args:
        messages: 消息列表

    Returns:
        估算的 token 数
    """
    total_chars = 0
    for msg in messages:
        try:
            total_chars += len(json.dumps(msg, ensure_ascii=False))
        except Exception:
            total_chars += len(str(msg))

    return total_chars // 4


def trim_old_messages(messages: list[dict[str, Any]], max_tokens: int = 150_000) -> list[dict[str, Any]]:
    """超过阈值时，删除最旧的消息

    策略：删除最旧的 20% 消息

    Args:
        messages: 消息列表
        max_tokens: 最大 token 数

    Returns:
        清理后的消息列表
    """
    current_tokens = estimate_tokens(messages)

    if current_tokens < max_tokens:
        return messages

    # 删除最旧的 20% 消息
    keep_count = int(len(messages) * 0.8)
    if keep_count < 2:
        keep_count = 2  # 至少保留 2 条消息

    return messages[-keep_count:]
