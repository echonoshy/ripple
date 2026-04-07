"""工具使用上下文

定义工具执行时的上下文信息。
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class ToolOptions:
    """工具选项"""

    tools: List[Any] = field(default_factory=list)  # 实际类型是 List[Tool]
    model: str = "anthropic/claude-3.5-sonnet"
    max_tokens: Optional[int] = None
    temperature: float = 1.0


@dataclass
class ToolUseContext:
    """工具使用上下文

    包含工具执行所需的所有上下文信息。
    """

    options: ToolOptions
    session_id: str
    cwd: str = "."
    abort_signal: Optional[Any] = None  # 中断信号
    read_file_state: Dict[str, Any] = field(default_factory=dict)  # 文件读取状态缓存

    # 权限相关
    permission_mode: str = "ask"  # ask, allow, deny
    allowed_tools: List[str] = field(default_factory=list)

    # 回调函数
    on_progress: Optional[Callable] = None
    on_notification: Optional[Callable] = None

    def with_options(self, options: ToolOptions) -> "ToolUseContext":
        """创建新上下文，更新选项"""
        from dataclasses import replace

        return replace(self, options=options)

    def with_allowed_tools(self, tools: List[str]) -> "ToolUseContext":
        """创建新上下文，更新允许的工具"""
        from dataclasses import replace

        return replace(self, allowed_tools=[*self.allowed_tools, *tools])
