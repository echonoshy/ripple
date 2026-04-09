"""工具使用上下文

定义工具执行时的上下文信息。
"""

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any


@dataclass
class ToolOptions:
    """工具选项"""

    tools: list[Any] = field(default_factory=list)
    model: str = "anthropic/claude-sonnet-4.6"
    max_tokens: int | None = None


@dataclass
class ToolUseContext:
    """工具使用上下文

    包含工具执行所需的所有上下文信息。
    """

    options: ToolOptions
    session_id: str
    cwd: Path = field(default_factory=Path.cwd)
    abort_signal: Any | None = None
    read_file_state: dict[str, Any] = field(default_factory=dict)

    thinking: bool = False
    permission_mode: str = "ask"
    allowed_tools: list[str] = field(default_factory=list)
    permission_manager: Any | None = None

    on_progress: Callable | None = None
    on_notification: Callable | None = None
    on_pause_spinner: Callable | None = None
    on_resume_spinner: Callable | None = None

    def with_options(self, options: ToolOptions) -> "ToolUseContext":
        """创建新上下文，更新选项"""
        return replace(self, options=options)

    def with_allowed_tools(self, tools: list[str]) -> "ToolUseContext":
        """创建新上下文，追加允许的工具（去重）"""
        merged = list(dict.fromkeys([*self.allowed_tools, *tools]))
        return replace(self, allowed_tools=merged)
