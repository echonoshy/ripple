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

    async def check_permission(self, tool: Tool, input_params: dict, context=None) -> tuple[bool, str | None]:
        """检查是否允许执行工具

        Args:
            tool: 工具实例
            input_params: 工具输入参数
            context: 工具使用上下文（可选，用于暂停/恢复 spinner）

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
        return await self._ask_user(tool, input_params, context)

    async def _ask_user(self, tool: Tool, input_params: dict, context=None) -> tuple[bool, str | None]:
        """询问用户是否允许"""
        # 暂停 spinner，避免覆盖用户输入
        if context and hasattr(context, "on_pause_spinner") and context.on_pause_spinner:
            context.on_pause_spinner()

        # 清空当前行
        self.console.print()

        # 构建更友好的参数显示
        params_display = self._format_params_for_display(tool.name, input_params)

        # 显示工具信息
        info = f"""[bold yellow]⚠️  需要确认危险操作[/bold yellow]

[bold]工具[/bold]: {tool.name}
[bold]风险级别[/bold]: {tool.risk_level.value}

{params_display}
        """
        self.console.print(Panel(info, border_style="yellow", padding=(1, 2)))

        # 询问用户
        self.console.print("\n[bold]选项:[/bold]")
        self.console.print("  [green]y[/green] - 允许这次")
        self.console.print("  [green]a[/green] - 本次会话总是允许此工具")
        self.console.print("  [red]n[/red] - 拒绝")

        choice = Prompt.ask("请选择", choices=["y", "a", "n"], default="n")

        # 恢复 spinner
        if context and hasattr(context, "on_resume_spinner") and context.on_resume_spinner:
            context.on_resume_spinner()

        if choice == "n":
            self.console.print("[red]✗ 操作已拒绝[/red]\n")
            return False, "User denied permission"

        elif choice == "a":
            self.session_allowed.add(tool.name)
            self.console.print(f"[green]✓ 已将 {tool.name} 添加到会话白名单[/green]\n")
            return True, None

        else:  # y
            self.console.print("[green]✓ 操作已允许[/green]\n")
            return True, None

    def _format_params_for_display(self, tool_name: str, params: dict) -> str:
        """格式化参数用于显示

        Args:
            tool_name: 工具名称
            params: 参数字典

        Returns:
            格式化后的参数字符串
        """
        if tool_name == "Bash":
            command = params.get("command", "")
            return f"[bold]命令[/bold]: [cyan]{command}[/cyan]"

        elif tool_name == "Write":
            file_path = params.get("file_path", "")
            content_preview = params.get("content", "")[:100]
            if len(params.get("content", "")) > 100:
                content_preview += "..."
            return f"""[bold]文件[/bold]: [cyan]{file_path}[/cyan]
[bold]操作[/bold]: 覆盖现有文件
[bold]内容预览[/bold]: {content_preview}"""

        else:
            # 默认显示 JSON
            return f"""[bold]参数[/bold]:
```json
{json.dumps(params, ensure_ascii=False, indent=2)[:500]}
```"""
