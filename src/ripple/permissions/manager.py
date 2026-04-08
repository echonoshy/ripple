"""权限管理器"""

import json

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt

from ripple.permissions.levels import PermissionMode
from ripple.tools.base import Tool


class PermissionManager:
    """权限管理器"""

    def __init__(self, mode: PermissionMode = PermissionMode.SMART):
        self.mode = mode
        self.session_allowed: set[str] = set()  # 本次会话已允许的工具
        self.console = Console()

    async def check_permission(self, tool: Tool, input_params: dict) -> tuple[bool, str | None]:
        """检查是否允许执行工具

        Args:
            tool: 工具实例
            input_params: 工具输入参数

        Returns:
            (是否允许, 拒绝原因)
        """
        # 模式 1: 全部允许
        if self.mode == PermissionMode.ALLOW_ALL:
            return True, None

        # 模式 2: 全部拒绝
        if self.mode == PermissionMode.DENY_ALL:
            return False, "Permission denied by policy"

        # 检查是否已在本次会话中允许
        if tool.name in self.session_allowed:
            return True, None

        # 模式 3: 智能模式
        if self.mode == PermissionMode.SMART:
            if not tool.requires_confirmation(input_params):
                return True, None  # 安全操作，直接允许

        # 模式 4: 询问模式 或 智能模式的危险操作
        return await self._ask_user(tool, input_params)

    async def _ask_user(self, tool: Tool, input_params: dict) -> tuple[bool, str | None]:
        """询问用户是否允许"""
        # 显示工具信息
        info = f"""
**工具**: {tool.name}
**风险级别**: {tool.risk_level.value}
**参数**:
```json
{json.dumps(input_params, ensure_ascii=False, indent=2)[:500]}
```
        """
        self.console.print(Panel(info, title="🔐 权限请求", border_style="yellow"))

        # 询问用户
        self.console.print("\n选项:")
        self.console.print("  [cyan]y[/cyan] - 允许这次")
        self.console.print("  [cyan]a[/cyan] - 本次会话总是允许")
        self.console.print("  [cyan]n[/cyan] - 拒绝")

        choice = Prompt.ask("请选择", choices=["y", "a", "n"], default="y")

        if choice == "n":
            return False, "User denied permission"

        elif choice == "a":
            self.session_allowed.add(tool.name)
            self.console.print(f"[green]✓ 已将 {tool.name} 添加到会话白名单[/green]")
            return True, None

        else:  # y
            return True, None
