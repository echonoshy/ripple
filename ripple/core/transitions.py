"""状态转换类型定义

定义 Agent Loop 的终止和继续条件。
"""

from dataclasses import dataclass
from typing import Literal

# ============ Terminal 类型（循环终止） ============


@dataclass
class TerminalCompleted:
    """任务完成"""

    reason: Literal["completed"] = "completed"


@dataclass
class TerminalPromptTooLong:
    """提示过长"""

    reason: Literal["prompt_too_long"] = "prompt_too_long"


@dataclass
class TerminalImageError:
    """图片错误"""

    reason: Literal["image_error"] = "image_error"


@dataclass
class TerminalModelError:
    """模型错误"""

    reason: Literal["model_error"] = "model_error"
    error: Exception


@dataclass
class TerminalAbortedStreaming:
    """流式响应被中断"""

    reason: Literal["aborted_streaming"] = "aborted_streaming"


@dataclass
class TerminalAbortedTools:
    """工具执行被中断"""

    reason: Literal["aborted_tools"] = "aborted_tools"


@dataclass
class TerminalBlockingLimit:
    """达到阻塞限制"""

    reason: Literal["blocking_limit"] = "blocking_limit"


@dataclass
class TerminalStopHookPrevented:
    """Stop Hook 阻止继续"""

    reason: Literal["stop_hook_prevented"] = "stop_hook_prevented"


@dataclass
class TerminalHookStopped:
    """Hook 停止"""

    reason: Literal["hook_stopped"] = "hook_stopped"


@dataclass
class TerminalMaxTurns:
    """达到最大轮数"""

    reason: Literal["max_turns"] = "max_turns"
    turn_count: int


Terminal = (
    TerminalCompleted
    | TerminalPromptTooLong
    | TerminalImageError
    | TerminalModelError
    | TerminalAbortedStreaming
    | TerminalAbortedTools
    | TerminalBlockingLimit
    | TerminalStopHookPrevented
    | TerminalHookStopped
    | TerminalMaxTurns
)


# ============ Continue 类型（循环继续） ============


@dataclass
class ContinueNextTurn:
    """进入下一轮"""

    reason: Literal["next_turn"] = "next_turn"


@dataclass
class ContinueMaxOutputTokensRecovery:
    """Max Output Tokens 恢复"""

    reason: Literal["max_output_tokens_recovery"] = "max_output_tokens_recovery"
    attempt: int


@dataclass
class ContinueMaxOutputTokensEscalate:
    """Max Output Tokens 升级"""

    reason: Literal["max_output_tokens_escalate"] = "max_output_tokens_escalate"


@dataclass
class ContinueReactiveCompactRetry:
    """Reactive Compact 重试"""

    reason: Literal["reactive_compact_retry"] = "reactive_compact_retry"


@dataclass
class ContinueStopHookBlocking:
    """Stop Hook 阻塞"""

    reason: Literal["stop_hook_blocking"] = "stop_hook_blocking"


@dataclass
class ContinueTokenBudgetContinuation:
    """Token Budget 继续"""

    reason: Literal["token_budget_continuation"] = "token_budget_continuation"


Continue = (
    ContinueNextTurn
    | ContinueMaxOutputTokensRecovery
    | ContinueMaxOutputTokensEscalate
    | ContinueReactiveCompactRetry
    | ContinueStopHookBlocking
    | ContinueTokenBudgetContinuation
)
