"""硬截断压缩策略（不调用 LLM）

当 LLM 摘要失败或断路器开启时使用：直接丢弃旧消息并插入边界说明。
定向裁剪 (`targeted_trim`) 用于 reactive compact 场景，当 API 返回精确的
token 超额量时，只移除刚好够弥合差距的消息。
"""

from typing import TYPE_CHECKING

from ripple.compact.boundaries import find_safe_boundary, find_turn_boundary
from ripple.messages.types import Message
from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger
from ripple.utils.token_counter import estimate_messages_tokens

if TYPE_CHECKING:
    from ripple.compact.auto_compact import AutoCompactor

logger = get_logger("compact.truncate")


def hard_truncate(
    compactor: "AutoCompactor",
    messages: list[Message],
    turns_to_keep: int | None = None,
) -> list[Message]:
    """硬截断压缩 — 不调用 LLM，直接丢弃旧消息"""
    keep = turns_to_keep or compactor.preserved_turns
    split_index = find_turn_boundary(messages, keep)
    if split_index <= 0:
        logger.warning("没有足够的轮次可以压缩，跳过")
        return messages

    preserved = messages[split_index:]
    discarded = messages[:split_index]
    discarded_count = len(discarded)
    discarded_tokens = estimate_messages_tokens(discarded)

    logger.info(
        "硬截断压缩: 丢弃 {} 条旧消息 (约 {} tokens)，保留最近 {} 条",
        discarded_count,
        discarded_tokens,
        len(preserved),
    )

    boundary = create_user_message(
        content=(
            f"[Conversation history compacted] "
            f"{discarded_count} older messages ({discarded_tokens:,} tokens) have been removed "
            f"to stay within context limits. "
            f"The most recent {len(preserved)} messages are preserved below. "
            f"Continue the conversation naturally."
        ),
        is_compact_boundary=True,
    )

    result = [boundary, *preserved]
    compactor.reset_cache()
    return result


def targeted_trim(
    compactor: "AutoCompactor",
    messages: list[Message],
    token_gap: int,
) -> list[Message]:
    """定向裁剪 — 只移除足够的旧消息来弥合 token 差距

    从最旧的消息开始逐条累积 token 数，直到释放量 >= gap + 安全余量；
    不足时回退到激进硬截断。
    """
    safety_margin = 5000
    target_to_free = token_gap + safety_margin

    freed = 0
    split_index = 0

    for i, msg in enumerate(messages):
        if freed >= target_to_free:
            break
        freed += estimate_messages_tokens([msg])
        split_index = i + 1

    if split_index <= 0 or split_index >= len(messages) - 1:
        logger.warning(
            "定向裁剪不足 (freed={}, needed={})，回退到激进硬截断",
            freed,
            target_to_free,
        )
        aggressive_turns = max(3, compactor.preserved_turns // 2)
        return hard_truncate(compactor, messages, turns_to_keep=aggressive_turns)

    split_index = find_safe_boundary(messages, split_index)

    preserved = messages[split_index:]
    discarded = messages[:split_index]
    discarded_tokens = estimate_messages_tokens(discarded)

    logger.info(
        "定向裁剪: 移除 {} 条消息 (~{} tokens) 以弥合 {} tokens 的差距",
        len(discarded),
        discarded_tokens,
        token_gap,
    )

    boundary = create_user_message(
        content=(
            f"[Conversation history compacted] "
            f"{len(discarded)} older messages ({discarded_tokens:,} tokens) have been removed "
            f"to stay within context limits. "
            f"The most recent {len(preserved)} messages are preserved below."
        ),
        is_compact_boundary=True,
    )

    result = [boundary, *preserved]
    compactor.reset_cache()
    return result
