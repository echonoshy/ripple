"""轻量级上下文清理（不调用 LLM）

单次遍历消息列表，把已完成轮次的 tool_result 内容与过大的 tool_use input
替换为占位符，以释放 token 空间。当前正在进行的轮次内所有 tool 数据保留
（避免模型在数据积累阶段丢信息）。
"""

import copy
from typing import TYPE_CHECKING

from ripple.compact.boundaries import find_last_user_turn_start
from ripple.messages.types import Message
from ripple.utils.logger import get_logger

if TYPE_CHECKING:
    from ripple.compact.auto_compact import AutoCompactor

logger = get_logger("compact.cleanup")

# lightweight_cleanup 中可压缩的工具名集合
COMPACTABLE_TOOLS = {
    "Bash",
    "Read",
    "Write",
    "Search",
    "Glob",
    "Grep",
    "Agent",
    "Skill",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
}

# 工具结果被清理后的占位符
CLEARED_PLACEHOLDER = "[Tool result cleared to save context]"

# tool_use input 大于此字符数时清理
TOOL_INPUT_MAX_CHARS = 500

# tool_use input 被清理后的占位符
TOOL_INPUT_PLACEHOLDER = {"_note": "Arguments omitted from prior conversation turn"}


def lightweight_cleanup(
    compactor: "AutoCompactor",
    messages: list[Message],
    preserve_recent: int = 5,
) -> list[Message]:
    """合并的轻量级清理

    单次遍历完成：
    1. 旧的 tool_result 内容替换为占位符（保留最近 preserve_recent 个）
    2. 旧的 tool_use input 过大时替换为占位符

    如果没有任何修改，返回原 list 对象（保持 `is` 检查兼容）。
    会更新 compactor 的 token 缓存。
    """
    compactable_indices: list[tuple[int, int]] = []

    for msg_idx, msg in enumerate(messages):
        if isinstance(msg, dict) or getattr(msg, "type", None) != "user":
            continue
        content = msg.message.get("content", [])
        if not isinstance(content, list):
            continue
        for block_idx, block in enumerate(content):
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tool_name = block.get("tool_name", "")
            if tool_name not in COMPACTABLE_TOOLS:
                continue
            content_val = block.get("content", "")
            if content_val == CLEARED_PLACEHOLDER:
                continue
            compactable_indices.append((msg_idx, block_idx))

    tool_input_indices: list[tuple[int, int]] = []

    for msg_idx, msg in enumerate(messages):
        if isinstance(msg, dict) or getattr(msg, "type", None) != "assistant":
            continue
        content = msg.message.get("content", [])
        if not isinstance(content, list):
            continue
        for block_idx, block in enumerate(content):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            inp = block.get("input", {})
            if isinstance(inp, dict) and inp == TOOL_INPUT_PLACEHOLDER:
                continue
            if isinstance(inp, dict) and len(str(inp)) > TOOL_INPUT_MAX_CHARS:
                tool_input_indices.append((msg_idx, block_idx))

    # 找到当前轮次起点，保护当前任务的所有 tool 数据不被清理
    current_turn_start = find_last_user_turn_start(messages)

    old_turn_results = [(mi, bi) for mi, bi in compactable_indices if mi < current_turn_start]
    to_clear_results = old_turn_results[:-preserve_recent] if len(old_turn_results) > preserve_recent else []

    old_turn_inputs = [(mi, bi) for mi, bi in tool_input_indices if mi < current_turn_start]

    if not to_clear_results and not old_turn_inputs:
        return messages

    result = list(messages)
    modified_msgs: dict[int, Message] = {}
    freed_chars = 0
    cleared_count = 0

    for msg_idx, block_idx in to_clear_results:
        if msg_idx not in modified_msgs:
            msg = result[msg_idx]
            new_msg = copy.copy(msg)
            new_msg.message = copy.deepcopy(msg.message)
            modified_msgs[msg_idx] = new_msg
            result[msg_idx] = new_msg

        block = modified_msgs[msg_idx].message["content"][block_idx]
        old_content = block.get("content", "")
        if isinstance(old_content, str):
            freed_chars += len(old_content)
        block["content"] = CLEARED_PLACEHOLDER
        cleared_count += 1

    input_cleared = 0
    for msg_idx, block_idx in old_turn_inputs:
        if msg_idx not in modified_msgs:
            msg = result[msg_idx]
            new_msg = copy.copy(msg)
            new_msg.message = copy.deepcopy(msg.message)
            modified_msgs[msg_idx] = new_msg
            result[msg_idx] = new_msg

        block = modified_msgs[msg_idx].message["content"][block_idx]
        old_input = block.get("input", {})
        freed_chars += len(str(old_input))
        block["input"] = TOOL_INPUT_PLACEHOLDER
        input_cleared += 1

    freed_tokens = freed_chars // 4
    compactor._cached_token_count = max(0, compactor._cached_token_count - freed_tokens)

    if cleared_count > 0 or input_cleared > 0:
        logger.info(
            "Lightweight cleanup: 清理 {} 个 tool_result + {} 个 tool_input (释放约 {} chars / {} tokens)",
            cleared_count,
            input_cleared,
            freed_chars,
            freed_tokens,
        )

    return result
