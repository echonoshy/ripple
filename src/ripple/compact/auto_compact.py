"""自动压缩系统

当消息历史过长时自动压缩，以支持长对话。
支持两种模式：硬截断 和 LLM 摘要压缩（优先使用后者）。

阈值从配置的 model.max_tokens 动态计算（默认 75%），
同时支持用 API 返回的真实 prompt_tokens 校准估算。
"""

import copy

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

# LLM 摘要连续失败断路器阈值
SUMMARIZATION_FAILURE_THRESHOLD = 3

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
        self._system_overhead: int = 0  # system prompt + tool definitions 的 token 开销
        self._consecutive_summary_failures: int = 0  # LLM 摘要连续失败计数

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

        # 减去 overhead，使缓存值与 estimate_messages_tokens 的口径一致
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

    def lightweight_cleanup(
        self,
        messages: list[Message],
        preserve_recent: int = 5,
    ) -> list[Message]:
        """合并的轻量级清理（替代原 micro_compact + context_cleanup）

        单次遍历完成：
        1. 旧的 tool_result 内容替换为占位符（保留最近 preserve_recent 个）
        2. 旧的 tool_use input 过大时替换为占位符

        如果没有任何修改，返回原 list 对象（保持 is 检查兼容）。
        """
        # 收集所有可压缩的 tool_result 位置
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

        # 收集需要清理 tool_use input 的 assistant 消息位置
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

        # 确定需要清理的 tool_result
        to_clear_results = compactable_indices[:-preserve_recent] if len(compactable_indices) > preserve_recent else []

        if not to_clear_results and not tool_input_indices:
            return messages

        result = list(messages)
        modified_msgs: dict[int, Message] = {}
        freed_chars = 0
        cleared_count = 0

        # 清理旧 tool_result
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

        # 清理过大的 tool_use input
        input_cleared = 0
        for msg_idx, block_idx in tool_input_indices:
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

        # 更新 token 缓存
        freed_tokens = freed_chars // 4
        self._cached_token_count = max(0, self._cached_token_count - freed_tokens)

        if cleared_count > 0 or input_cleared > 0:
            logger.info(
                "Lightweight cleanup: 清理 {} 个 tool_result + {} 个 tool_input (释放约 {} chars / {} tokens)",
                cleared_count,
                input_cleared,
                freed_chars,
                freed_tokens,
            )

        return result

    async def compact(self, messages: list[Message], context: ToolUseContext) -> list[Message]:
        """压缩消息历史

        优先使用 LLM 摘要压缩，失败则 fallback 到硬截断。
        连续失败超过断路器阈值后，跳过 LLM 直接硬截断。
        """
        if self._consecutive_summary_failures >= SUMMARIZATION_FAILURE_THRESHOLD:
            logger.warning(
                "断路器开启: 连续 {} 次摘要失败，直接使用硬截断",
                self._consecutive_summary_failures,
            )
            return self._hard_truncate(messages)

        try:
            result, _ = await self.compact_with_summary(messages, context)
            return result
        except Exception as e:
            logger.warning("compact_with_summary 失败，使用硬截断: {}", e)
            return self._hard_truncate(messages)

    async def reactive_compact(
        self,
        messages: list[Message],
        context: ToolUseContext,
        token_gap: int | None = None,
    ) -> list[Message]:
        """被动触发压缩 — 当 API 返回 context_length_exceeded 时调用

        如果提供了 token_gap，使用定向裁剪只移除足够的消息来弥合差距。
        否则回退到激进的轮数减半策略。
        """
        logger.warning("Reactive compact 触发：上下文超出模型窗口，进行紧急压缩")

        # 定向裁剪：有精确的 token 超额量时使用
        if token_gap is not None and token_gap > 0:
            return self._targeted_trim(messages, token_gap)

        aggressive_turns = max(3, self.preserved_turns // 2)

        if self._consecutive_summary_failures >= SUMMARIZATION_FAILURE_THRESHOLD:
            logger.warning("断路器开启，跳过 LLM 进行 reactive compact")
            return self._hard_truncate(messages, turns_to_keep=aggressive_turns)

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
            is_compact_boundary=True,
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

    @staticmethod
    def _find_safe_boundary(messages: list[Message], proposed_index: int) -> int:
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

    def _targeted_trim(self, messages: list[Message], token_gap: int) -> list[Message]:
        """定向裁剪 — 只移除足够的旧消息来弥合 token 差距

        从最旧的消息开始逐条累积 token 数，直到释放量 >= gap + 安全余量。
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
            aggressive_turns = max(3, self.preserved_turns // 2)
            return self._hard_truncate(messages, turns_to_keep=aggressive_turns)

        # 调整到安全边界
        split_index = self._find_safe_boundary(messages, split_index)

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
        self.reset_cache()
        return result

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
            self._consecutive_summary_failures = 0  # 成功，重置计数
        except Exception as e:
            self._consecutive_summary_failures += 1
            logger.warning(
                "LLM 摘要生成失败 ({}/{})，fallback 到硬截断: {}",
                self._consecutive_summary_failures,
                SUMMARIZATION_FAILURE_THRESHOLD,
                e,
            )
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
            is_compact_boundary=True,
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
