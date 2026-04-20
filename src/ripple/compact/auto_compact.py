"""自动压缩协调器

当消息历史过长时自动压缩，以支持长对话。本模块仅负责：
- 触发判定（`should_compact`）、token 估算校准
- 压缩策略选择（LLM 摘要 / 定向裁剪 / 硬截断）
- 状态持久化（get_state / from_state）
- 连续失败断路器

具体策略实现见 `cleanup.py` / `truncate.py` / `summary.py`；
纯边界查找见 `boundaries.py`。
"""

from ripple.compact.cleanup import lightweight_cleanup as _lightweight_cleanup
from ripple.compact.summary import (
    SUMMARIZATION_FAILURE_THRESHOLD,
)
from ripple.compact.summary import (
    compact_with_summary as _compact_with_summary,
)
from ripple.compact.summary import (
    compact_with_turns as _compact_with_turns,
)
from ripple.compact.truncate import hard_truncate as _hard_truncate
from ripple.compact.truncate import targeted_trim as _targeted_trim
from ripple.core.context import ToolUseContext
from ripple.messages.types import Message
from ripple.utils.logger import get_logger
from ripple.utils.token_counter import estimate_messages_tokens

logger = get_logger("compact.auto_compact")

# 触发压缩的安全比例（模型上下文窗口 × COMPACT_RATIO）
COMPACT_RATIO = 0.75

# 压缩后保留的最近消息轮数
DEFAULT_PRESERVED_TURNS = 10


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
    """自动压缩器（协调器）

    对外暴露统一的压缩入口：
    - `should_compact`：基于增量 token 估算判断是否需要压缩
    - `compact`：正常触发，优先 LLM 摘要，失败回退硬截断
    - `reactive_compact`：API 返回 context_length_exceeded 时的紧急压缩
    - `lightweight_cleanup`：不调用 LLM 的工具结果清理
    - `calibrate_with_api_tokens`：用 API 返回的真实 prompt_tokens 校准估算
    """

    def __init__(self, threshold: int | None = None, preserved_turns: int | None = None):
        self.threshold = threshold or _get_compact_threshold()
        self.preserved_turns = preserved_turns or DEFAULT_PRESERVED_TURNS
        self._cached_token_count = 0
        self._cached_message_count = 0
        self._system_overhead: int = 0  # system prompt + tool definitions 的 token 开销
        self._consecutive_summary_failures: int = 0  # LLM 摘要连续失败计数

    # ------------------------------------------------------------------ #
    # 触发判定 / 估算校准
    # ------------------------------------------------------------------ #

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

        API 的 prompt_tokens 包含 system prompt + tool definitions 的开销，
        而 estimate_messages_tokens() 只估算消息本身。需要减去 overhead 以保持口径一致。
        """
        if actual_prompt_tokens <= 0:
            return

        old = self._cached_token_count
        overhead = actual_prompt_tokens - old

        if overhead > 0:
            if self._system_overhead == 0:
                self._system_overhead = overhead
            else:
                # EMA 平滑，避免测量噪声
                self._system_overhead = int(0.7 * self._system_overhead + 0.3 * overhead)

        calibrated = actual_prompt_tokens - self._system_overhead
        self._cached_token_count = max(calibrated, 0)

        if abs(old - self._cached_token_count) > 5000:
            logger.debug(
                "Token 估算校准: {} -> {} (API={}, overhead={})",
                old,
                self._cached_token_count,
                actual_prompt_tokens,
                self._system_overhead,
            )

    def reset_cache(self):
        """压缩后重置缓存（overhead 保留，它是结构性的不随压缩变化）"""
        self._cached_token_count = 0
        self._cached_message_count = 0

    # ------------------------------------------------------------------ #
    # 状态持久化
    # ------------------------------------------------------------------ #

    def get_state(self) -> dict:
        """序列化 compactor 状态，用于持久化"""
        return {
            "threshold": self.threshold,
            "preserved_turns": self.preserved_turns,
            "system_overhead": self._system_overhead,
            "consecutive_summary_failures": self._consecutive_summary_failures,
        }

    @classmethod
    def from_state(cls, state: dict) -> "AutoCompactor":
        """从持久化状态恢复 compactor"""
        instance = cls(
            threshold=state.get("threshold"),
            preserved_turns=state.get("preserved_turns"),
        )
        instance._system_overhead = state.get("system_overhead", 0)
        instance._consecutive_summary_failures = state.get("consecutive_summary_failures", 0)
        # 恢复后强制重新估算 token 数，避免缓存与实际消息列表不一致
        instance._cached_token_count = 0
        instance._cached_message_count = 0
        return instance

    # ------------------------------------------------------------------ #
    # 压缩策略分派
    # ------------------------------------------------------------------ #

    def lightweight_cleanup(
        self,
        messages: list[Message],
        preserve_recent: int = 5,
    ) -> list[Message]:
        """不调用 LLM 的轻量级清理（清空旧 tool_result / tool_use input）"""
        return _lightweight_cleanup(self, messages, preserve_recent=preserve_recent)

    async def compact(self, messages: list[Message], context: ToolUseContext) -> list[Message]:
        """正常触发压缩：优先 LLM 摘要，失败或断路器开启则硬截断"""
        if self._consecutive_summary_failures >= SUMMARIZATION_FAILURE_THRESHOLD:
            logger.warning(
                "断路器开启: 连续 {} 次摘要失败，直接使用硬截断",
                self._consecutive_summary_failures,
            )
            return _hard_truncate(self, messages)

        try:
            result, _ = await _compact_with_summary(self, messages, context)
            return result
        except Exception as e:
            logger.warning("compact_with_summary 失败，使用硬截断: {}", e)
            return _hard_truncate(self, messages)

    async def reactive_compact(
        self,
        messages: list[Message],
        context: ToolUseContext,
        token_gap: int | None = None,
    ) -> list[Message]:
        """紧急压缩：API 返回 context_length_exceeded 时调用

        - 若提供 token_gap，先尝试定向裁剪；不足时回退
        - 否则 LLM 摘要（保留轮数减半）；失败则硬截断
        """
        logger.warning("Reactive compact 触发：上下文超出模型窗口，进行紧急压缩")

        if token_gap is not None and token_gap > 0:
            return _targeted_trim(self, messages, token_gap)

        aggressive_turns = max(3, self.preserved_turns // 2)

        if self._consecutive_summary_failures >= SUMMARIZATION_FAILURE_THRESHOLD:
            logger.warning("断路器开启，跳过 LLM 进行 reactive compact")
            return _hard_truncate(self, messages, turns_to_keep=aggressive_turns)

        try:
            result, _ = await _compact_with_turns(self, messages, context, aggressive_turns)
            return result
        except Exception as e:
            logger.warning("Reactive compact 摘要失败，使用激进硬截断: {}", e)
            return _hard_truncate(self, messages, turns_to_keep=aggressive_turns)

    async def compact_with_summary(
        self,
        messages: list[Message],
        context: ToolUseContext,
    ) -> tuple[list[Message], str]:
        """直接调用 LLM 摘要压缩（供外部显式使用）"""
        return await _compact_with_summary(self, messages, context)


# 全局单例
_global_compactor: AutoCompactor | None = None


def get_global_compactor() -> AutoCompactor:
    """获取全局压缩器实例"""
    global _global_compactor
    if _global_compactor is None:
        _global_compactor = AutoCompactor()
    return _global_compactor
