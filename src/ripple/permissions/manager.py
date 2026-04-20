"""权限管理器"""

import json
from typing import Any

from ripple.permissions.levels import PermissionMode
from ripple.tools.base import Tool
from ripple.utils.logger import get_logger

logger = get_logger("permissions.manager")


class PermissionManager:
    """权限管理器

    所有危险操作通过 `stop_agent_loop` 挂起 agent loop 并向前端发出权限请求，
    由前端交互完成确认后再恢复。
    """

    def __init__(self, mode: PermissionMode = PermissionMode.SMART):
        self.mode = mode
        self.session_allowed: set[str] = set()
        self.one_time_allowed: set[str] = set()

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

        perm_key = self._build_permission_key(tool, input_params)
        if perm_key in self.one_time_allowed:
            self.one_time_allowed.remove(perm_key)
            return True, None, None
        if perm_key in self.session_allowed:
            return True, None, None

        if not tool.requires_confirmation(input_params):
            return True, None, None

        return await self._request_confirmation(tool, input_params)

    async def _request_confirmation(
        self, tool: Tool, input_params: dict
    ) -> tuple[bool, str | None, dict[str, Any] | None]:
        """挂起危险操作并返回权限请求元数据，交由前端确认。"""
        logger.warning(
            "权限拦截危险操作: {} | 参数: {}",
            tool.name,
            json.dumps(input_params, ensure_ascii=False)[:200],
        )
        reason = f"This operation ({tool.name}) requires user confirmation before it can continue."
        return False, reason, self.build_permission_request(tool, input_params)
