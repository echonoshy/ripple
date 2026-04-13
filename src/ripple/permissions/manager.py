"""权限管理器"""

import json

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt

from ripple.permissions.levels import PermissionMode
from ripple.tools.base import Tool
from ripple.utils.logger import get_logger

logger = get_logger("permissions.manager")


class PermissionManager:
    """权限管理器"""

    def __init__(self, mode: PermissionMode = PermissionMode.SMART):
        self.mode = mode
        self.session_allowed: set[str] = set()
        self.console = Console()

    def _build_permission_key(self, tool: Tool, input_params: dict) -> str:
        """构建细粒度的权限 key（工具名 + 操作指纹）"""
        if tool.name == "Bash":
            return f"Bash:{input_params.get('command', '')}"
        elif tool.name == "Write":
            return f"Write:{input_params.get('file_path', '')}"
        else:
            return f"{tool.name}:{json.dumps(input_params, sort_keys=True)}"

    async def check_permission(self, tool: Tool, input_params: dict, context=None) -> tuple[bool, str | None]:
        """检查是否允许执行工具

        Returns:
            (是否允许, 拒绝原因)
        """
        if self.mode == PermissionMode.ALLOW_ALL:
            return True, None

        if self.mode == PermissionMode.DENY_ALL:
            return False, "Permission denied by policy"

        perm_key = self._build_permission_key(tool, input_params)
        if perm_key in self.session_allowed:
            return True, None

        if self.mode in (PermissionMode.SMART, PermissionMode.SERVER_SMART):
            if not tool.requires_confirmation(input_params):
                return True, None

        if self.mode == PermissionMode.SERVER_SMART:
            return await self._server_deny_dangerous(tool, input_params)

        return await self._ask_user(tool, input_params, context)

    async def _server_deny_dangerous(self, tool: Tool, input_params: dict) -> tuple[bool, str | None]:
        """Server 模式：拒绝危险操作并提示模型使用 AskUser 先征求用户同意"""
        logger.warning(
            "Server 权限拦截危险操作: {} | 参数: {}",
            tool.name,
            json.dumps(input_params, ensure_ascii=False)[:200],
        )
        reason = (
            f"This operation ({tool.name}) requires user confirmation. "
            f"Use the AskUser tool to explain what you want to do and ask for permission first. "
            f"After the user approves, retry this operation."
        )
        return False, reason

    async def _ask_user(self, tool: Tool, input_params: dict, context=None) -> tuple[bool, str | None]:
        """询问用户是否允许"""
        if context and hasattr(context, "on_pause_spinner") and context.on_pause_spinner:
            context.on_pause_spinner()

        self.console.print()

        params_display = self._format_params_for_display(tool.name, input_params)

        info = f"""[bold yellow]⚠️  需要确认危险操作[/bold yellow]

[bold]工具[/bold]: {tool.name}
[bold]风险级别[/bold]: {tool.risk_level.value}

{params_display}
        """
        self.console.print(Panel(info, border_style="yellow", padding=(1, 2)))

        self.console.print("\n[bold]选项:[/bold]")
        self.console.print("  [green]y[/green] - 允许这次")
        self.console.print("  [green]a[/green] - 本次会话总是允许此操作")
        self.console.print("  [red]n[/red] - 拒绝")

        choice = Prompt.ask("请选择", choices=["y", "a", "n"], default="n")

        if context and hasattr(context, "on_resume_spinner") and context.on_resume_spinner:
            context.on_resume_spinner()

        if choice == "n":
            self.console.print("[red]✗ 操作已拒绝[/red]\n")
            return False, "User denied permission"

        elif choice == "a":
            perm_key = self._build_permission_key(tool, input_params)
            self.session_allowed.add(perm_key)
            self.console.print("[green]✓ 已将此操作添加到会话白名单[/green]\n")
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
