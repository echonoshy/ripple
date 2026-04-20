"""消息列表切割边界查找

所有函数都是纯函数：给定消息列表返回索引，不修改输入，不依赖 AutoCompactor
状态。抽出到独立模块便于单测，也让压缩策略文件聚焦于"压缩动作"本身。
"""

from ripple.messages.types import Message


def find_turn_boundary(messages: list[Message], turns_to_keep: int) -> int:
    """从末尾往前找到第 N 轮 user 消息的起始位置

    Returns:
        切割位置索引；若 user 消息数 <= turns_to_keep 则返回 0（不需切）。
    """
    user_indices = [i for i, m in enumerate(messages) if getattr(m, "type", None) == "user"]
    if len(user_indices) <= turns_to_keep:
        return 0
    return user_indices[-turns_to_keep]


def find_last_user_turn_start(messages: list[Message]) -> int:
    """找到最后一个真实用户消息的索引（当前对话轮次的起点）

    真实用户消息 = 用户直接输入的文本消息（非 tool_result 包装消息）。
    当前轮次内的所有 tool 数据不应被轻量清理，防止模型在数据积累阶段丢失信息。
    """
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if isinstance(msg, dict) or getattr(msg, "type", None) != "user":
            continue
        content = msg.message.get("content", [])
        if isinstance(content, str):
            return i
        if isinstance(content, list):
            is_pure_tool_result = all(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content if isinstance(b, dict)
            )
            if not is_pure_tool_result:
                return i
    return 0


def find_safe_boundary(messages: list[Message], proposed_index: int) -> int:
    """调整切割位置，避免在 tool_use/tool_result 配对中间切割

    从 proposed_index 向后找到下一个安全的切割点（非 tool_result 的 user 消息）。
    """
    n = len(messages)
    idx = proposed_index
    while idx < n - 1:
        msg = messages[idx]
        if getattr(msg, "type", None) == "user":
            content = msg.message.get("content", [])
            if isinstance(content, str):
                return idx
            if isinstance(content, list):
                has_tool_result = any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
                if not has_tool_result:
                    return idx
        idx += 1
    return proposed_index
