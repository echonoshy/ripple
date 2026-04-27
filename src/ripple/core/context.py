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

    current_messages: list[Any] = field(default_factory=list)

    # Session / 沙箱相关
    workspace_root: Path | None = None  # 沙箱 workspace（用户文件所在）
    sandbox_session_id: str | None = None  # 沙箱对应的 session_id（用于 nsjail 执行）
    session_runtime_dir: Path | None = None  # session 运行时数据目录（tasks.json/task-outputs/ 的父目录）
    user_id: str | None = None  # 沙箱绑定的 user_id（Phase 3 起；None 表示旧 session-only 模式）
    sandbox_manager: Any | None = None
    sandboxed: bool = False

    on_progress: Callable | None = None
    on_notification: Callable | None = None

    @property
    def is_sandboxed(self) -> bool:
        """当前 context 是否绑定到 nsjail 沙箱。"""
        return self.sandboxed and self.workspace_root is not None

    def with_options(self, options: ToolOptions) -> "ToolUseContext":
        """创建新上下文，更新选项"""
        return replace(self, options=options)

    def with_allowed_tools(self, tools: list[str]) -> "ToolUseContext":
        """创建新上下文，追加允许的工具（去重）"""
        merged = list(dict.fromkeys([*self.allowed_tools, *tools]))
        return replace(self, allowed_tools=merged)
