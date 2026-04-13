"""Microcompact — 轻量级 tool_result 清理

在不调用 LLM 的情况下，通过清空旧的 tool_result 内容来释放 token 空间。
参考 Claude Code 的 microcompact 策略。
"""

import copy

from ripple.messages.types import Message
from ripple.utils.logger import get_logger

logger = get_logger("compact.micro_compact")

COMPACTABLE_TOOLS = {"Bash", "Read", "Write", "Search", "Glob", "Grep"}

CLEARED_PLACEHOLDER = "[Tool result cleared to save context]"


def microcompact_messages(
    messages: list[Message],
    preserve_recent: int = 5,
) -> list[Message]:
    """清空旧的可压缩工具结果内容

    策略：从末尾往前数，保留最近 preserve_recent 个可压缩工具的结果不动，
    更早的 tool_result 内容替换为占位符。

    Args:
        messages: 消息列表
        preserve_recent: 保留最近多少个工具结果不清理

    Returns:
        处理后的消息列表（浅拷贝，仅修改被清理的消息）
    """
    compactable_indices: list[tuple[int, int]] = []

    for msg_idx, msg in enumerate(messages):
        if msg.type != "user":
            continue
        content = msg.message.get("content", [])
        if not isinstance(content, list):
            continue
        for block_idx, block in enumerate(content):
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_result":
                continue
            tool_name = block.get("tool_name", "")
            if tool_name not in COMPACTABLE_TOOLS:
                continue
            content_val = block.get("content", "")
            if content_val == CLEARED_PLACEHOLDER:
                continue
            compactable_indices.append((msg_idx, block_idx))

    if len(compactable_indices) <= preserve_recent:
        return messages

    to_clear = compactable_indices[:-preserve_recent]

    if not to_clear:
        return messages

    result = list(messages)
    cleared_count = 0
    freed_chars = 0

    modified_msgs: dict[int, Message] = {}

    for msg_idx, block_idx in to_clear:
        if msg_idx not in modified_msgs:
            msg = result[msg_idx]
            new_msg = copy.copy(msg)
            new_msg.message = copy.deepcopy(msg.message)
            modified_msgs[msg_idx] = new_msg
            result[msg_idx] = new_msg

        modified_msg = modified_msgs[msg_idx]
        block = modified_msg.message["content"][block_idx]
        old_content = block.get("content", "")
        if isinstance(old_content, str):
            freed_chars += len(old_content)
        block["content"] = CLEARED_PLACEHOLDER
        cleared_count += 1

    logger.info(
        "Microcompact: 清理了 {} 个旧工具结果 (释放约 {} 字符 / {} tokens)",
        cleared_count,
        freed_chars,
        freed_chars // 4,
    )

    return result
