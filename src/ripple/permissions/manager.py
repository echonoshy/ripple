"""权限管理器"""

import json
from typing import Any

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
        self.one_time_allowed: set[str] = set()
        self.console = Console()

    def _build_permission_key(self, tool: Tool, input_params: dict) -> str:
        """构建细粒度的权限 key（工具名 + 操作指纹）"""
        return self._build_permission_key_by_name(tool.name, input_params)

    def _build_permission_key_by_name(self, tool_name: str, input_params: dict) -> str:
        """根据工具名和参数构建权限 key。"""
        if tool_name == "Bash":
            return f"Bash:{input_params.get('command', '')}"
        if tool_name == "Write":
            return f"Write:{input_params.get('file_path', '')}"
        return f"{tool_name}:{json.dumps(input_params, sort_keys=True)}"

    def grant_permission(self, tool: Tool, input_params: dict, scope: str = "session") -> None:
        """授予权限，可按一次或整会话生效。"""
        perm_key = self._build_permission_key(tool, input_params)
        if scope == "once":
            self.one_time_allowed.add(perm_key)
            return
        self.session_allowed.add(perm_key)

    def grant_permission_request(self, permission_request: dict[str, Any], scope: str = "session") -> None:
        """根据挂起的权限请求授予权限。"""
        tool_name = permission_request.get("tool", "")
        params = permission_request.get("params", {})
        perm_key = self._build_permission_key_by_name(tool_name, params if isinstance(params, dict) else {})
        if scope == "once":
            self.one_time_allowed.add(perm_key)
            return
        self.session_allowed.add(perm_key)

    def build_permission_request(self, tool: Tool, input_params: dict) -> dict[str, Any]:
        """构建发给前端的权限请求元数据。"""
        return {
            "tool": tool.name,
            "params": input_params,
            "riskLevel": tool.risk_level.value,
        }

    async def check_permission(
        self, tool: Tool, input_params: dict, context=None
    ) -> tuple[bool, str | None, dict[str, Any] | None]:
        """检查是否允许执行工具。

        Returns:
            (是否允许, 拒绝原因, 权限请求元数据)
        """
        if self.mode == PermissionMode.ALLOW_ALL:
            return True, None, None

        if self.mode == PermissionMode.DENY_ALL:
            return False, "Permission denied by policy", None

        perm_key = self._build_permission_key(tool, input_params)
        if perm_key in self.one_time_allowed:
            self.one_time_allowed.remove(perm_key)
            return True, None, None
        if perm_key in self.session_allowed:
            return True, None, None

        if self.mode in (PermissionMode.SMART, PermissionMode.SERVER_SMART):
            if not tool.requires_confirmation(input_params):
                return True, None, None

        if self.mode == PermissionMode.SERVER_SMART:
            return await self._server_deny_dangerous(tool, input_params)

        return await self._ask_user(tool, input_params, context)

    async def _server_deny_dangerous(
        self, tool: Tool, input_params: dict
    ) -> tuple[bool, str | None, dict[str, Any] | None]:
        """Server 模式：暂停危险操作并返回权限请求元数据。"""
        logger.warning(
            "Server 权限拦截危险操作: {} | 参数: {}",
            tool.name,
            json.dumps(input_params, ensure_ascii=False)[:200],
        )
        reason = f"This operation ({tool.name}) requires user confirmation before it can continue."
        return False, reason, self.build_permission_request(tool, input_params)

    async def _ask_user(
        self, tool: Tool, input_params: dict, context=None
    ) -> tuple[bool, str | None, dict[str, Any] | None]:
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
            return False, "User denied permission", None

        elif choice == "a":
            self.grant_permission(tool, input_params, scope="session")
            self.console.print("[green]✓ 已将此操作添加到会话白名单[/green]\n")
            return True, None, None

        else:  # y
            self.console.print("[green]✓ 操作已允许[/green]\n")
            self.grant_permission(tool, input_params, scope="once")
            return True, None, None

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
