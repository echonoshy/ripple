"""查询状态管理

定义 Agent Loop 的状态结构。
"""

from dataclasses import dataclass, replace
from typing import Any, List, Optional

from ripple.core.transitions import Continue
from ripple.messages.types import Message


@dataclass
class QueryState:
    """查询状态

    在 Agent Loop 的每次迭代中传递的状态。
    """

    messages: List[Message]
    tool_use_context: Any  # 避免循环导入，实际类型是 ToolUseContext
    turn_count: int
    max_output_tokens_recovery_count: int = 0
    has_attempted_reactive_compact: bool = False
    max_output_tokens_override: Optional[int] = None
    stop_hook_active: Optional[bool] = None
    transition: Optional[Continue] = None

    def with_messages(self, messages: List[Message]) -> "QueryState":
        """创建新状态，更新消息列表"""
        return replace(self, messages=messages)

    def with_turn_count(self, turn_count: int) -> "QueryState":
        """创建新状态，更新轮数"""
        return replace(self, turn_count=turn_count)

    def with_transition(self, transition: Continue) -> "QueryState":
        """创建新状态，更新转换原因"""
        return replace(self, transition=transition)

    def increment_recovery_count(self) -> "QueryState":
        """创建新状态，增加恢复计数"""
        return replace(self, max_output_tokens_recovery_count=self.max_output_tokens_recovery_count + 1)
