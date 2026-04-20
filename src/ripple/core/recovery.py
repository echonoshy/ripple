"""Agent Loop 错误恢复机制

`ErrorRecovery` 处理 max_output_tokens 错误的两阶段恢复（先升级 max_tokens，
再注入 recovery 消息让模型继续）。`ModelFallback` 在主模型不可用时切到
备用模型。二者都按 per-loop 实例持有状态。
"""

from typing import Any

from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger

logger = get_logger("core.recovery")


class ErrorRecovery:
    """错误恢复管理器"""

    # max_output_tokens 最大恢复次数
    MAX_OUTPUT_TOKENS_RETRIES = 3
    # 升级因子：默认 max_output_tokens × 该系数
    ESCALATION_FACTOR = 1.5

    def __init__(self):
        self.recovery_count = 0
        self._escalation_attempted: bool = False

    def reset(self):
        """重置恢复计数"""
        self.recovery_count = 0
        self._escalation_attempted = False

    def can_escalate_max_output_tokens(self) -> bool:
        """检查是否可以尝试升级 max_output_tokens（在注入 recovery 消息前先尝试）"""
        return not self._escalation_attempted

    def get_escalated_max_tokens(self) -> int:
        """获取升级后的 max_tokens 值，并标记已尝试升级"""
        from ripple.utils.config import get_config

        config = get_config()
        default = config.get("model.max_output_tokens", 60000)
        self._escalation_attempted = True
        return int(default * self.ESCALATION_FACTOR)

    def can_recover_max_output_tokens(self) -> bool:
        """检查是否还有 max_output_tokens 错误的恢复配额"""
        return self.recovery_count < self.MAX_OUTPUT_TOKENS_RETRIES

    def create_recovery_message(self) -> Any:
        """创建 max_output_tokens 恢复消息（提示模型继续输出）"""
        self.recovery_count += 1

        logger.info(
            "创建 max_output_tokens 恢复消息 (尝试 {}/{})",
            self.recovery_count,
            self.MAX_OUTPUT_TOKENS_RETRIES,
        )

        return create_user_message(
            content=(
                "Output token limit hit. Resume directly — no apology, no recap of what you were doing. "
                "Pick up mid-thought if that is where the cut happened. "
                "Break remaining work into smaller pieces."
            ),
        )


class ModelFallback:
    """模型 Fallback 管理器"""

    def __init__(self, primary_model: str, fallback_model: str | None = None):
        self.primary_model = primary_model
        self.fallback_model = fallback_model
        self.has_fallen_back = False

    def should_fallback(self, error: Exception) -> bool:
        """是否应对该错误执行 fallback（基于错误字符串关键字）"""
        if not self.fallback_model:
            return False
        if self.has_fallen_back:
            return False

        error_str = str(error).lower()
        retryable_errors = [
            "overloaded",
            "rate limit",
            "capacity",
            "unavailable",
            "timeout",
            "503",
            "529",
        ]
        return any(err in error_str for err in retryable_errors)

    def get_current_model(self) -> str:
        """获取当前应该使用的模型"""
        if self.has_fallen_back and self.fallback_model:
            return self.fallback_model
        return self.primary_model

    def execute_fallback(self) -> str:
        """切换到 fallback 模型并返回新模型名"""
        if not self.fallback_model:
            raise ValueError("No fallback model configured")

        self.has_fallen_back = True
        logger.warning("模型 fallback: {} -> {}", self.primary_model, self.fallback_model)
        return self.fallback_model


_global_recovery: ErrorRecovery | None = None


def get_global_recovery() -> ErrorRecovery:
    """获取全局错误恢复管理器（进程级单例）"""
    global _global_recovery
    if _global_recovery is None:
        _global_recovery = ErrorRecovery()
    return _global_recovery
