"""Bash 工具

执行 shell 命令。
CLI 模式：直接在宿主机执行。
Server 模式：通过 nsjail 在沙箱中执行。
"""

import asyncio
import re
from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bash")

# 匹配需要 Python venv 的命令（支持管道、&&、绝对路径等）
_PYTHON_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*(?:uv\s+(?:pip|run|add)|(?:/\S+/)?python3?|(?:/\S+/)?pip3?)\b",
)

# 匹配需要 pnpm 全局环境的命令
_NODE_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*(?:pnpm|npx|npm|node|corepack|lark-cli)\b",
)


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


def set_sandbox_config(config):
    global _sandbox_config
    _sandbox_config = config


def _needs_python_venv(command: str) -> bool:
    """判断命令是否需要 Python venv 环境"""
    return bool(_PYTHON_CMD_PATTERN.search(command))


def _needs_node_env(command: str) -> bool:
    """判断命令是否需要 Node.js/pnpm 环境"""
    return bool(_NODE_CMD_PATTERN.search(command))


class BashTool(Tool[BashInput, BashOutput]):
    """Bash 工具"""

    def __init__(self):
        self.name = "Bash"
        self.description = "Execute a bash command and return the output"
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
            if context.is_server_mode and context.sandbox_session_id and _sandbox_config:
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
        return None

    async def _ensure_venv_if_needed(self, command: str, session_id: str) -> str | None:
        """如果命令需要 Python 且 venv 不存在，懒创建之。返回错误信息或 None。"""
        if not _needs_python_venv(command):
            return None

        if _sandbox_config.has_python_venv(session_id):
            return None

        from ripple.sandbox.executor import ensure_python_venv

        success, msg = await ensure_python_venv(_sandbox_config, session_id)
        if not success:
            return f"[SANDBOX] Failed to initialize Python venv: {msg}"
        return None

    async def _ensure_pnpm_if_needed(self, command: str, session_id: str) -> str | None:
        """如果命令需要 Node.js/pnpm 且全局环境未初始化，懒创建之。返回错误信息或 None。"""
        if not _needs_node_env(command):
            return None

        if not _sandbox_config.node_dir:
            return "[SANDBOX] Node.js is not available. Please install Node.js on the host."

        if _sandbox_config.has_pnpm_setup(session_id):
            return None

        from ripple.sandbox.executor import ensure_pnpm_setup

        success, msg = await ensure_pnpm_setup(_sandbox_config, session_id)
        if not success:
            return f"[SANDBOX] Failed to initialize pnpm environment: {msg}"
        return None

    def _wrap_with_venv_activation(self, command: str, session_id: str) -> str:
        """如果 workspace 内存在 venv，自动在命令前激活它"""
        if _sandbox_config.has_python_venv(session_id):
            return f". /workspace/.venv/bin/activate && {command}"
        return command

    async def _execute_in_sandbox(self, args: BashInput, context: ToolUseContext) -> tuple[str, str, int]:
        """通过 nsjail 在沙箱中执行"""
        from ripple.sandbox.executor import execute_in_sandbox

        session_id = context.sandbox_session_id

        # 懒创建 Python venv（失败时直接返回错误，不继续执行）
        if venv_err := await self._ensure_venv_if_needed(args.command, session_id):
            return "", venv_err, 1

        # 懒初始化 pnpm 全局环境（失败时直接返回错误，不继续执行）
        if pnpm_err := await self._ensure_pnpm_if_needed(args.command, session_id):
            return "", pnpm_err, 1

        # 自动激活已有 venv
        command = self._wrap_with_venv_activation(args.command, session_id)

        stdout, stderr, exit_code = await execute_in_sandbox(
            command,
            _sandbox_config,
            session_id,
            timeout=args.timeout,
        )

        from ripple.sandbox.workspace import check_workspace_quota

        exceeded, size_bytes = check_workspace_quota(_sandbox_config, session_id)
        if exceeded:
            size_mb = size_bytes / (1024 * 1024)
            stderr += f"\n[SANDBOX] Warning: workspace size ({size_mb:.1f}MB) exceeds quota ({_sandbox_config.max_workspace_mb}MB)"

        return stdout, stderr, exit_code

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
