"""query_loop 入参容器"""

from typing import TYPE_CHECKING

from ripple.core.context import ToolUseContext
from ripple.messages.types import Message

if TYPE_CHECKING:
    from ripple.compact.auto_compact import AutoCompactor


class QueryParams:
    """查询参数"""

    def __init__(
        self,
        messages: list[Message],
        tool_use_context: ToolUseContext,
        model: str = "anthropic/claude-sonnet-4.6",
        max_turns: int | None = None,
        max_tokens: int | None = None,
        thinking: bool | None = None,
        compactor: "AutoCompactor | None" = None,
        temperature: float | None = None,
    ):
        self.messages = messages
        self.tool_use_context = tool_use_context
        self.model = model
        self.max_turns = max_turns
        self.max_tokens = max_tokens
        self.thinking = thinking
        self.compactor = compactor
        self.temperature = temperature
