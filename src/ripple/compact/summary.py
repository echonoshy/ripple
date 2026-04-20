"""LLM 摘要压缩策略

调用小模型（默认 haiku）对被丢弃的旧消息生成自然语言摘要，
以 `[Conversation Summary]` 边界消息的形式替换原消息序列。
摘要失败时由上层 `AutoCompactor` fallback 到硬截断。
"""

from typing import TYPE_CHECKING

from ripple.compact.boundaries import find_turn_boundary
from ripple.compact.truncate import hard_truncate
from ripple.core.context import ToolUseContext
from ripple.messages.types import Message
from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger
from ripple.utils.token_counter import estimate_messages_tokens

if TYPE_CHECKING:
    from ripple.compact.auto_compact import AutoCompactor

logger = get_logger("compact.summary")

# 发送给摘要模型的最大 token 数（防止摘要请求自身溢出）
SUMMARY_INPUT_MAX_TOKENS = 80_000

# LLM 摘要连续失败断路器阈值
SUMMARIZATION_FAILURE_THRESHOLD = 3


async def compact_with_summary(
    compactor: "AutoCompactor",
    messages: list[Message],
    context: ToolUseContext,
) -> tuple[list[Message], str]:
    """使用 LLM 摘要压缩（按 compactor 默认保留轮数）"""
    return await compact_with_turns(compactor, messages, context, compactor.preserved_turns)


async def compact_with_turns(
    compactor: "AutoCompactor",
    messages: list[Message],
    context: ToolUseContext,
    turns: int,
) -> tuple[list[Message], str]:
    """使用 LLM 摘要压缩，指定保留轮数"""
    split_index = find_turn_boundary(messages, turns)
    if split_index <= 0:
        return messages, ""

    discarded = messages[:split_index]
    preserved = messages[split_index:]

    try:
        summary = await _generate_summary(discarded, context)
        compactor._consecutive_summary_failures = 0
    except Exception as e:
        compactor._consecutive_summary_failures += 1
        logger.warning(
            "LLM 摘要生成失败 ({}/{})，fallback 到硬截断: {}",
            compactor._consecutive_summary_failures,
            SUMMARIZATION_FAILURE_THRESHOLD,
            e,
        )
        compacted = hard_truncate(compactor, messages, turns_to_keep=turns)
        return compacted, f"Compacted {len(messages) - len(compacted)} messages (fallback)"

    boundary = create_user_message(
        content=(
            f"[Conversation Summary]\n"
            f"The earlier part of this conversation ({len(discarded)} messages, "
            f"~{estimate_messages_tokens(discarded):,} tokens) has been summarized:\n\n"
            f"{summary}\n\n"
            f"The most recent {len(preserved)} messages are preserved below. "
            f"Continue the conversation naturally using the summary as context."
        ),
        is_compact_boundary=True,
    )

    result = [boundary, *preserved]
    compactor.reset_cache()

    logger.info(
        "LLM 摘要压缩完成: {} 条旧消息 -> 摘要 ({} 字符), 保留 {} 条",
        len(discarded),
        len(summary),
        len(preserved),
    )

    return result, summary


async def _generate_summary(messages: list[Message], context: ToolUseContext) -> str:
    """调用 LLM 生成消息摘要，对输入做预截断以防溢出"""
    from ripple.api.client import create_client
    from ripple.compact.compact_prompt import (
        COMPACT_SYSTEM_PROMPT,
        COMPACT_USER_PROMPT_TEMPLATE,
        format_compact_summary,
    )
    from ripple.messages.cleanup import estimate_tokens as estimate_dict_tokens
    from ripple.messages.utils import (
        create_system_message,
        create_user_message,
        normalize_messages_for_api,
    )
    from ripple.utils.config import get_config

    config = get_config()
    compact_model = config.get("model.compact_model", config.resolve_model("haiku"))

    # 估算：先用 OpenAI 规范化下算 token，避免两种 provider 做不同估算
    normalized = normalize_messages_for_api(messages)
    total_tokens = estimate_dict_tokens(normalized)
    cut_off_index = 0
    if total_tokens > SUMMARY_INPUT_MAX_TOKENS:
        logger.info("摘要输入过长 ({} tokens)，截断到 {} tokens", total_tokens, SUMMARY_INPUT_MAX_TOKENS)
        running = 0
        keep_from = len(messages)
        for i in range(len(messages) - 1, -1, -1):
            msg_tokens = estimate_dict_tokens(normalize_messages_for_api([messages[i]]))
            if running + msg_tokens > SUMMARY_INPUT_MAX_TOKENS:
                break
            running += msg_tokens
            keep_from = i
        cut_off_index = keep_from

    # 构造 Ripple 内部格式的消息序列，交给 client 自行适配 provider
    compact_messages: list[Message] = [create_system_message(content=COMPACT_SYSTEM_PROMPT)]
    compact_messages.extend(messages[cut_off_index:])
    compact_messages.append(create_user_message(content=COMPACT_USER_PROMPT_TEMPLATE))

    client = create_client()
    response = await client.complete(
        messages=compact_messages,
        model=compact_model,
        max_tokens=4096,
        thinking=False,
    )

    raw_text = response.get("text", "") if isinstance(response, dict) else ""
    if not raw_text:
        raise ValueError("Empty response from compact model")

    return format_compact_summary(raw_text)
