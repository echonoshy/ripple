"""Bash 工具

执行 shell 命令。
CLI 模式：直接在宿主机执行。
Server 模式：通过 nsjail 在沙箱中执行。
"""

import asyncio
from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bash")


class BashInput(BaseModel):
    """Bash 工具输入"""

    command: str = Field(description="要执行的 shell 命令")
    timeout: int = Field(default=120, description="超时时间（秒）")


class BashOutput(BaseModel):
    """Bash 工具输出"""

    stdout: str
    stderr: str
    exit_code: int


# 全局沙箱配置引用（由 server 启动时设置）
_sandbox_config = None
# 全局 SandboxManager 引用（用于获取 per-user lock）
_sandbox_manager = None


def set_sandbox_config(config):
    global _sandbox_config
    _sandbox_config = config


def set_sandbox_manager(manager):
    global _sandbox_manager
    _sandbox_manager = manager


class BashTool(Tool[BashInput, BashOutput]):
    """Bash 工具"""

    def __init__(self):
        self.name = "Bash"
        self.description = (
            "Execute a bash command and return the output. Do not use Bash to schedule future work; "
            "use the Schedule tool for reminders, delayed follow-ups, run-later work, and recurring tasks."
        )
        self.max_result_size_chars = 100_000
        self.risk_level = ToolRiskLevel.DANGEROUS

    async def call(
        self,
        args: BashInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[BashOutput]:
        if isinstance(args, dict):
            args = BashInput(**args)

        if error := self._check_blocked_commands(args.command):
            return ToolResult(data=BashOutput(stdout="", stderr=error, exit_code=1))

        try:
            if context.is_sandboxed and _sandbox_config:
                stdout, stderr, exit_code = await self._execute_in_sandbox(args, context)
            else:
                stdout, stderr, exit_code = await self._execute_direct(args, context)

            return ToolResult(data=BashOutput(stdout=stdout, stderr=stderr, exit_code=exit_code))

        except Exception as e:
            from ripple.utils.errors import error_message

            return ToolResult(
                data=BashOutput(stdout="", stderr=f"Command execution failed: {error_message(e)}", exit_code=-1)
            )

    def _check_blocked_commands(self, command: str) -> str | None:
        """检查命令是否包含被禁止的模式，返回错误信息或 None。"""
        import shlex

        try:
            tokens = shlex.split(command)
        except ValueError:
            tokens = command.split()

        if any(tok == "sudo" for tok in tokens) or command.lstrip().startswith("sudo "):
            return (
                "Error: sudo is not supported in this environment. "
                "The subprocess has no interactive stdin, so sudo will hang waiting for a password. "
                "Please run the command without sudo."
            )
        if self._looks_like_scheduling_emulation(tokens, command):
            return (
                "Error: do not emulate scheduled work with Bash sleep/at/cron/background loops. "
                "Use the Schedule tool so the job is persisted and visible in scheduled task history."
            )
        return None

    def _looks_like_scheduling_emulation(self, tokens: list[str], command: str) -> bool:
        if not tokens:
            return False
        first = tokens[0]
        if first in {"at", "crontab"}:
            return True
        has_background_or_chain = any(tok in {"&", "&&", ";"} for tok in tokens) or "&" in command
        return "sleep" in tokens and has_background_or_chain

    async def _execute_in_sandbox(self, args: BashInput, context: ToolUseContext) -> tuple[str, str, int]:
        """通过 nsjail 在沙箱中执行（user-scoped）"""
        from ripple.sandbox.command_runner import run_sandbox_command

        user_id = context.user_id
        if not user_id:
            return "", "[SANDBOX] 当前上下文没有 user_id，无法定位 sandbox", 1

        async def _run() -> tuple[str, str, int]:
            return await run_sandbox_command(
                args.command,
                _sandbox_config,
                user_id,
                timeout=args.timeout,
            )

        # 同一 user 的多 session 共享 workspace，以 per-user lock 串行化
        # 保护 workspace 级 provisioning（venv/pnpm/lark-cli setup）和文件写入。
        if _sandbox_manager is not None:
            async with _sandbox_manager.user_lock(user_id):
                return await _run()
        return await _run()

    async def _execute_direct(self, args: BashInput, context: ToolUseContext) -> tuple[str, str, int]:
        """直接在宿主机执行（CLI 模式）"""
        proc = await asyncio.create_subprocess_shell(
            args.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=context.cwd,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=args.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return "", f"Command timed out after {args.timeout} seconds", -1

        stdout = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
        stderr = stderr_bytes.decode(errors="replace") if stderr_bytes else ""
        return stdout, stderr, proc.returncode or 0

    def is_concurrency_safe(self, input: BashInput | dict[str, Any]) -> bool:
        return False

    def log_input_summary(self, input_params: dict[str, Any]) -> dict[str, Any]:
        """Bash 命令本身排障价值很高，完整保留（但超过 400 字符截断）"""
        cmd = input_params.get("command", "") or ""
        if len(cmd) > 400:
            cmd = cmd[:400] + f"...[+{len(cmd) - 400}]"
        return {
            "command": cmd,
            "timeout": input_params.get("timeout", 120),
        }

    def log_result_summary(self, result_data: Any) -> dict[str, Any]:
        if isinstance(result_data, BashOutput):
            return {
                "exit_code": result_data.exit_code,
                "stdout_bytes": len(result_data.stdout),
                "stderr_bytes": len(result_data.stderr),
            }
        return super().log_result_summary(result_data)

    def _get_parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default: 120)",
                    "default": 120,
                },
            },
            "required": ["command"],
        }

    def requires_confirmation(self, input_params: dict) -> bool:
        command = input_params.get("command", "").lower()

        destructive_patterns = [
            "rm -rf",
            "rm -fr",
            "rm -r",
            "rm ",
            "rmdir",
            "unlink",
            "> /dev/null",
        ]
        git_dangerous = [
            "git push --force",
            "git push -f",
            "git reset --hard",
            "git clean -fd",
            "git branch -d",
            "git branch -D",
            "git rebase",
            "git push",
        ]
        database_dangerous = ["drop table", "drop database", "delete from", "truncate"]
        system_dangerous = [
            "sudo",
            "chmod 777",
            "chmod -r",
            "chown",
            "kill -9",
            "pkill",
            "shutdown",
            "reboot",
            "mkfs",
            "dd if=",
        ]
        package_dangerous = [
            "apt-get remove",
            "apt remove",
            "yum remove",
            "brew uninstall",
            "pip uninstall",
            "npm uninstall -g",
        ]

        all_patterns = destructive_patterns + git_dangerous + database_dangerous + system_dangerous + package_dangerous
        return any(pattern in command for pattern in all_patterns)
