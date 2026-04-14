"""自动压缩系统

当消息历史过长时自动压缩，以支持长对话。
支持两种模式：硬截断 和 LLM 摘要压缩（优先使用后者）。

阈值从配置的 model.max_tokens 动态计算（默认 75%），
同时支持用 API 返回的真实 prompt_tokens 校准估算。
"""

from ripple.core.context import ToolUseContext
from ripple.messages.types import Message
from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger
from ripple.utils.token_counter import estimate_messages_tokens

logger = get_logger("compact.auto_compact")

# 触发压缩的安全比例（模型上下文窗口 × COMPACT_RATIO）
COMPACT_RATIO = 0.75

# 压缩后保留的最近消息轮数
DEFAULT_PRESERVED_TURNS = 10

# 发送给摘要模型的最大 token 数（防止摘要请求自身溢出）
SUMMARY_INPUT_MAX_TOKENS = 80_000


def _get_compact_threshold() -> int:
    """从配置计算压缩阈值"""
    try:
        from ripple.utils.config import get_config

        config = get_config()
        max_tokens = config.get("model.max_tokens", 200_000)
        return int(max_tokens * COMPACT_RATIO)
    except Exception:
        return 150_000


class AutoCompactor:
    """自动压缩器

    当消息历史超过阈值时，自动压缩旧消息。
    支持两种触发方式：
    1. 主动检查：should_compact() 用估算 token 判断
    2. 被动触发：reactive_compact() 在 API 返回 context_length_exceeded 时调用
    """

    def __init__(self, threshold: int | None = None, preserved_turns: int | None = None):
        self.threshold = threshold or _get_compact_threshold()
        self.preserved_turns = preserved_turns or DEFAULT_PRESERVED_TURNS
        self._cached_token_count = 0
        self._cached_message_count = 0

    def should_compact(self, messages: list[Message]) -> bool:
        """检查是否需要压缩（增量估算 token 数）"""
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

    def calibrate_with_api_tokens(self, actual_prompt_tokens: int):
        """用 API 返回的真实 prompt_tokens 校准缓存

        每次 API 调用后，如果返回了 usage.prompt_tokens，
        用它替换估算值，使下一轮的 should_compact 更准确。
        """
        if actual_prompt_tokens > 0:
            old = self._cached_token_count
            self._cached_token_count = actual_prompt_tokens
            if abs(old - actual_prompt_tokens) > 5000:
                logger.debug("Token 估算校准: {} -> {} (API 真实值)", old, actual_prompt_tokens)

    def reset_cache(self):
        """压缩后重置缓存"""
        self._cached_token_count = 0
        self._cached_message_count = 0

    async def compact(self, messages: list[Message], context: ToolUseContext) -> list[Message]:
        """压缩消息历史

        优先使用 LLM 摘要压缩，失败则 fallback 到硬截断。
        """
        try:
            result, _ = await self.compact_with_summary(messages, context)
            return result
        except Exception as e:
            logger.warning("compact_with_summary 失败，使用硬截断: {}", e)
            return self._hard_truncate(messages)

    async def reactive_compact(self, messages: list[Message], context: ToolUseContext) -> list[Message]:
        """被动触发压缩 — 当 API 返回 context_length_exceeded 时调用

        比主动压缩更激进：保留更少的轮数。
        """
        logger.warning("Reactive compact 触发：上下文超出模型窗口，进行紧急压缩")
        aggressive_turns = max(3, self.preserved_turns // 2)

        try:
            result, _ = await self._compact_with_turns(messages, context, aggressive_turns)
            return result
        except Exception as e:
            logger.warning("Reactive compact 摘要失败，使用激进硬截断: {}", e)
            return self._hard_truncate(messages, turns_to_keep=aggressive_turns)

    def _hard_truncate(self, messages: list[Message], turns_to_keep: int | None = None) -> list[Message]:
        """硬截断压缩 — 不调用 LLM，直接丢弃旧消息"""
        keep = turns_to_keep or self.preserved_turns
        split_index = self._find_turn_boundary(messages, keep)
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
        """从末尾往前找到第 N 轮 user 消息的起始位置"""
        user_indices = [i for i, m in enumerate(messages) if getattr(m, "type", None) == "user"]
        if len(user_indices) <= turns_to_keep:
            return 0
        return user_indices[-turns_to_keep]

    async def compact_with_summary(self, messages: list[Message], context: ToolUseContext) -> tuple[list[Message], str]:
        """使用 LLM 摘要压缩（默认保留轮数）"""
        return await self._compact_with_turns(messages, context, self.preserved_turns)

    async def _compact_with_turns(
        self, messages: list[Message], context: ToolUseContext, turns: int
    ) -> tuple[list[Message], str]:
        """使用 LLM 摘要压缩，指定保留轮数"""
        split_index = self._find_turn_boundary(messages, turns)
        if split_index <= 0:
            return messages, ""

        discarded = messages[:split_index]
        preserved = messages[split_index:]

        try:
            summary = await self._generate_summary(discarded, context)
        except Exception as e:
            logger.warning("LLM 摘要生成失败，fallback 到硬截断: {}", e)
            compacted = self._hard_truncate(messages, turns_to_keep=turns)
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
        """调用 LLM 生成消息摘要，对输入做预截断以防溢出"""
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

        normalized = normalize_messages_for_api(messages)

        # 预截断：如果待摘要的消息超过限制，只保留尾部（更相关的部分）
        from ripple.messages.cleanup import estimate_tokens as estimate_dict_tokens

        total_tokens = estimate_dict_tokens(normalized)
        if total_tokens > SUMMARY_INPUT_MAX_TOKENS:
            logger.info("摘要输入过长 ({} tokens)，截断到 {} tokens", total_tokens, SUMMARY_INPUT_MAX_TOKENS)
            truncated: list[dict] = []
            running = 0
            for msg in reversed(normalized):
                msg_tokens = estimate_dict_tokens([msg])
                if running + msg_tokens > SUMMARY_INPUT_MAX_TOKENS:
                    break
                truncated.insert(0, msg)
                running += msg_tokens
            normalized = truncated

        api_messages: list[dict] = [{"role": "system", "content": COMPACT_SYSTEM_PROMPT}]
        api_messages.extend(normalized)
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
    """获取全局压缩器实例"""
    global _global_compactor
    if _global_compactor is None:
        _global_compactor = AutoCompactor()
    return _global_compactor
