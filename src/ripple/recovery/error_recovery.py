"""错误恢复机制

提供智能的错误恢复能力，包括 max_output_tokens 恢复和模型 fallback。
"""

from typing import Any

from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger

logger = get_logger("recovery.error_recovery")


class ErrorRecovery:
    """错误恢复管理器"""

    # max_output_tokens 最大恢复次数
    MAX_OUTPUT_TOKENS_RETRIES = 3

    def __init__(self):
        self.recovery_count = 0

    def reset(self):
        """重置恢复计数"""
        self.recovery_count = 0

    def can_recover_max_output_tokens(self) -> bool:
        """检查是否可以恢复 max_output_tokens 错误

        Returns:
            如果还有恢复次数则返回 True
        """
        return self.recovery_count < self.MAX_OUTPUT_TOKENS_RETRIES

    def create_recovery_message(self) -> Any:
        """创建 max_output_tokens 恢复消息

        Returns:
            恢复消息
        """
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
        """初始化 Fallback 管理器

        Args:
            primary_model: 主模型
            fallback_model: 备用模型
        """
        self.primary_model = primary_model
        self.fallback_model = fallback_model
        self.has_fallen_back = False

    def should_fallback(self, error: Exception) -> bool:
        """检查是否应该 fallback

        Args:
            error: 错误对象

        Returns:
            如果应该 fallback 则返回 True
        """
        if not self.fallback_model:
            return False

        if self.has_fallen_back:
            return False

        # 检查是否是可重试的错误
        error_str = str(error).lower()

        # 常见的可 fallback 错误
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
        """获取当前应该使用的模型

        Returns:
            模型名称
        """
        if self.has_fallen_back and self.fallback_model:
            return self.fallback_model
        return self.primary_model

    def execute_fallback(self) -> str:
        """执行 fallback

        Returns:
            Fallback 后的模型名称
        """
        if not self.fallback_model:
            raise ValueError("No fallback model configured")

        self.has_fallen_back = True
        logger.warning("模型 fallback: {} -> {}", self.primary_model, self.fallback_model)

        return self.fallback_model


# 全局恢复管理器
_global_recovery: ErrorRecovery | None = None


def get_global_recovery() -> ErrorRecovery:
    """获取全局错误恢复管理器

    Returns:
        全局恢复管理器
    """
    global _global_recovery
    if _global_recovery is None:
        _global_recovery = ErrorRecovery()
    return _global_recovery
