"""自动压缩系统

当消息历史过长时自动压缩，以支持长对话。
支持两种模式：硬截断 和 LLM 摘要压缩（优先使用后者）。
"""

from ripple.core.context import ToolUseContext
from ripple.messages.types import Message
from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger
from ripple.utils.token_counter import estimate_messages_tokens

logger = get_logger("compact.auto_compact")


class AutoCompactor:
    """自动压缩器

    当消息历史超过阈值时，自动压缩旧消息。
    """

    # 触发压缩的阈值（token 数量）
    THRESHOLD = 150_000

    # 压缩后保留的最近消息轮数
    PRESERVED_TURNS = 10

    def __init__(self, threshold: int | None = None, preserved_turns: int | None = None):
        """初始化压缩器

        Args:
            threshold: 触发压缩的阈值（token 数量）
            preserved_turns: 压缩后保留的最近消息轮数
        """
        self.threshold = threshold or self.THRESHOLD
        self.preserved_turns = preserved_turns or self.PRESERVED_TURNS
        self._cached_token_count = 0
        self._cached_message_count = 0

    def should_compact(self, messages: list[Message]) -> bool:
        """检查是否需要压缩（增量估算 token 数）

        Args:
            messages: 消息列表

        Returns:
            如果需要压缩则返回 True
        """
        msg_count = len(messages)
        if msg_count > self._cached_message_count:
            new_messages = messages[self._cached_message_count :]
            self._cached_token_count += estimate_messages_tokens(new_messages)
            self._cached_message_count = msg_count
        elif msg_count < self._cached_message_count:
            self._cached_token_count = estimate_messages_tokens(messages)
            self._cached_message_count = msg_count

        should = self._cached_token_count > self.threshold

        if should:
            logger.info("消息历史达到 {} tokens，超过阈值 {}，需要压缩", self._cached_token_count, self.threshold)

        return should

    def reset_cache(self):
        """压缩后重置缓存"""
        self._cached_token_count = 0
        self._cached_message_count = 0

    async def compact(self, messages: list[Message], context: ToolUseContext) -> list[Message]:
        """压缩消息历史

        优先使用 LLM 摘要压缩，失败则 fallback 到硬截断。

        Args:
            messages: 消息列表
            context: 工具使用上下文

        Returns:
            压缩后的消息列表
        """
        try:
            result, _ = await self.compact_with_summary(messages, context)
            return result
        except Exception as e:
            logger.warning("compact_with_summary 失败，使用硬截断: {}", e)
            return await self._hard_truncate(messages)

    async def _hard_truncate(self, messages: list[Message]) -> list[Message]:
        """硬截断压缩 — 不调用 LLM，直接丢弃旧消息"""
        split_index = self._find_turn_boundary(messages, self.preserved_turns)
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
        )

        result = [boundary, *preserved]
        self.reset_cache()
        return result

    @staticmethod
    def _find_turn_boundary(messages: list[Message], turns_to_keep: int) -> int:
        """从末尾往前找到第 N 轮 user 消息的起始位置

        一轮 = 一条 user 消息 + 后续所有 assistant/tool 消息

        Args:
            messages: 消息列表
            turns_to_keep: 要保留的轮数

        Returns:
            分割索引（该索引及之后的消息会被保留），若无法分割返回 0
        """
        user_indices = [i for i, m in enumerate(messages) if m.type == "user"]
        if len(user_indices) <= turns_to_keep:
            return 0
        return user_indices[-turns_to_keep]

    async def compact_with_summary(self, messages: list[Message], context: ToolUseContext) -> tuple[list[Message], str]:
        """压缩消息历史并使用 LLM 生成摘要

        使用轻量模型对旧消息生成结构化摘要，替代简单的硬截断。
        如果 LLM 摘要失败，fallback 到硬截断。

        Args:
            messages: 消息列表
            context: 工具使用上下文

        Returns:
            (压缩后的消息列表, 摘要文本)
        """
        split_index = self._find_turn_boundary(messages, self.preserved_turns)
        if split_index <= 0:
            return messages, ""

        discarded = messages[:split_index]
        preserved = messages[split_index:]

        try:
            summary = await self._generate_summary(discarded, context)
        except Exception as e:
            logger.warning("LLM 摘要生成失败，fallback 到硬截断: {}", e)
            compacted = await self.compact(messages, context)
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
        )

        result = [boundary, *preserved]
        self.reset_cache()

        logger.info(
            "LLM 摘要压缩完成: {} 条旧消息 -> 摘要 ({} 字符), 保留 {} 条",
            len(discarded),
            len(summary),
            len(preserved),
        )

        return result, summary

    async def _generate_summary(self, messages: list[Message], context: ToolUseContext) -> str:
        """调用 LLM 生成消息摘要"""
        from ripple.api.client import OpenRouterClient
        from ripple.compact.compact_prompt import (
            COMPACT_SYSTEM_PROMPT,
            COMPACT_USER_PROMPT_TEMPLATE,
            format_compact_summary,
        )
        from ripple.messages.utils import normalize_messages_for_api
        from ripple.utils.config import get_config

        config = get_config()
        compact_model = config.get("model.compact_model", config.resolve_model("haiku"))

        api_messages: list[dict] = [{"role": "system", "content": COMPACT_SYSTEM_PROMPT}]
        api_messages.extend(normalize_messages_for_api(messages))
        api_messages.append(
            {
                "role": "user",
                "content": COMPACT_USER_PROMPT_TEMPLATE,
            }
        )

        client = OpenRouterClient()
        response = await client.chat(
            messages=api_messages,
            model=compact_model,
            max_tokens=4096,
            thinking=False,
        )

        choices = response.get("choices", [])
        if not choices:
            raise ValueError("Empty response from compact model")

        raw_text = choices[0].get("message", {}).get("content", "")
        return format_compact_summary(raw_text)


# 全局单例
_global_compactor: AutoCompactor | None = None


def get_global_compactor() -> AutoCompactor:
    """获取全局压缩器实例

    Returns:
        全局压缩器
    """
    global _global_compactor
    if _global_compactor is None:
        _global_compactor = AutoCompactor()
    return _global_compactor
