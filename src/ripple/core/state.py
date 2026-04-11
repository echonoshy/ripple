"""查询状态管理

定义 Agent Loop 的状态结构。
"""

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from ripple.core.transitions import Continue, Terminal
from ripple.messages.types import Message

if TYPE_CHECKING:
    pass


@dataclass
class QueryState:
    """查询状态

    在 Agent Loop 的每次迭代中传递的状态。
    """

    messages: list[Message]
    tool_use_context: Any  # runtime type: ToolUseContext (TYPE_CHECKING avoids circular import)
    turn_count: int
    transition: Continue | Terminal | None = None

    def with_messages(self, messages: list[Message]) -> "QueryState":
        """创建新状态，更新消息列表"""
        return replace(self, messages=messages)

    def with_turn_count(self, turn_count: int) -> "QueryState":
        """创建新状态，更新轮数"""
        return replace(self, turn_count=turn_count)

    def with_transition(self, transition: Continue | Terminal) -> "QueryState":
        """创建新状态，更新转换原因"""
        return replace(self, transition=transition)
