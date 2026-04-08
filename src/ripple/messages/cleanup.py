"""消息清理工具

用于清理工具调用和结果，减少 token 消耗。
"""

import json

from ripple.messages.types import Message


def cleanup_tool_results(messages: list[Message]) -> list[Message]:
    """清理工具调用和结果，只保留助手的文本总结

    策略：
    - 保留助手消息中的文本内容
    - 删除助手消息中的 tool_use 块
    - 删除用户消息中的 tool_result 块
    - 保留普通用户消息

    Args:
        messages: 原始消息列表

    Returns:
        清理后的消息列表
    """
    cleaned = []

    for msg in messages:
        role = msg.get("role")

        if role == "assistant":
            # 只保留文本内容
            content = msg.get("content", [])
            if isinstance(content, str):
                cleaned.append(msg)
            elif isinstance(content, list):
                text_blocks = [block for block in content if isinstance(block, dict) and block.get("type") == "text"]
                if text_blocks:
                    cleaned.append(
                        {
                            "role": "assistant",
                            "content": text_blocks,
                            **{k: v for k, v in msg.items() if k not in ["role", "content"]},
                        }
                    )

        elif role == "user":
            # 删除 tool_result，保留普通消息
            content = msg.get("content", [])
            if isinstance(content, str):
                cleaned.append(msg)
            elif isinstance(content, list):
                non_tool_blocks = [
                    block for block in content if isinstance(block, dict) and block.get("type") != "tool_result"
                ]
                if non_tool_blocks:
                    cleaned.append(
                        {
                            "role": "user",
                            "content": non_tool_blocks,
                            **{k: v for k, v in msg.items() if k not in ["role", "content"]},
                        }
                    )

        else:
            # 保留其他类型的消息（system 等）
            cleaned.append(msg)

    return cleaned


def estimate_tokens(messages: list[Message]) -> int:
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


def trim_old_messages(messages: list[Message], max_tokens: int = 150_000) -> list[Message]:
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
