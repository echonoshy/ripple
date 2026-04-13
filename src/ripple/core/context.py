"""工具使用上下文

定义工具执行时的上下文信息。
"""

import asyncio
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


class AbortSignal:
    """可检查/可等待的中止信号"""

    def __init__(self):
        self._event = asyncio.Event()

    def abort(self):
        self._event.set()

    @property
    def is_aborted(self) -> bool:
        return self._event.is_set()


@dataclass
class ToolUseContext:
    """工具使用上下文

    包含工具执行所需的所有上下文信息。
    """

    options: ToolOptions
    session_id: str
    cwd: Path = field(default_factory=Path.cwd)
    abort_signal: AbortSignal | None = None
    read_file_state: dict[str, Any] = field(default_factory=dict)

    thinking: bool = False
    permission_mode: str = "ask"
    allowed_tools: list[str] = field(default_factory=list)
    permission_manager: Any | None = None

    is_server_mode: bool = False

    current_messages: list[Any] = field(default_factory=list)

    # 沙箱相关
    workspace_root: Path | None = None  # session 独立工作空间根目录（server 模式下设置）
    sandbox_session_id: str | None = None  # 沙箱对应的 session_id（用于 nsjail 执行）

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
