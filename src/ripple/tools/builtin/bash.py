"""Bash 工具

执行 shell 命令。
"""

import asyncio
import os
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
    timeout: int = Field(default=300, description="超时时间（秒）")


class BashOutput(BaseModel):
    """Bash 工具输出"""

    stdout: str
    stderr: str
    exit_code: int


class BashTool(Tool[BashInput, BashOutput]):
    """Bash 工具

    执行 shell 命令并返回结果。
    使用 asyncio 异步子进程，支持 stderr 实时流式输出。
    """

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
        """执行 bash 命令

        使用 asyncio 子进程，实时流式读取 stderr 进度信息。

        Args:
            args: 命令参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            执行结果
        """
        if isinstance(args, dict):
            args = BashInput(**args)

        try:
            env = {**os.environ, "PYTHONUNBUFFERED": "1"}

            process = await asyncio.create_subprocess_shell(
                args.command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=context.cwd,
                env=env,
            )
            logger.info("Bash 异步子进程已启动, pid={}", process.pid)

            stdout_parts: list[str] = []
            stderr_parts: list[str] = []

            def _emit_progress(text: str):
                if context.on_progress and text.strip():
                    try:
                        context.on_progress(text.strip())
                    except Exception as cb_err:
                        logger.warning("on_progress 回调异常: {}", cb_err)

            async def _read_stdout():
                assert process.stdout is not None
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        break
                    text = line.decode(errors="replace")
                    stdout_parts.append(text)
                    stripped = text.rstrip("\n")
                    if stripped.startswith("[ripple]"):
                        _emit_progress(stripped)

            async def _read_stderr():
                assert process.stderr is not None
                while True:
                    line = await process.stderr.readline()
                    if not line:
                        break
                    text = line.decode(errors="replace")
                    stderr_parts.append(text.rstrip("\n"))
                    _emit_progress(text.rstrip("\n"))

            try:
                await asyncio.wait_for(
                    asyncio.gather(_read_stdout(), _read_stderr(), process.wait()),
                    timeout=args.timeout,
                )
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                logger.warning("Bash 命令超时 ({}s), pid={}", args.timeout, process.pid)
                output = BashOutput(
                    stdout="".join(stdout_parts),
                    stderr=f"Command timed out after {args.timeout} seconds\n" + "\n".join(stderr_parts),
                    exit_code=-1,
                )
                return ToolResult(data=output)

            logger.info("Bash 命令完成, pid={}, exit_code={}", process.pid, process.returncode)
            output = BashOutput(
                stdout="".join(stdout_parts),
                stderr="\n".join(stderr_parts),
                exit_code=process.returncode or 0,
            )
            return ToolResult(data=output)

        except Exception as e:
            from ripple.utils.errors import error_message

            logger.error("Bash 命令执行异常: {}", e)
            output = BashOutput(
                stdout="",
                stderr=f"Command execution failed: {error_message(e)}",
                exit_code=-1,
            )
            return ToolResult(data=output)

    def is_concurrency_safe(self, input: BashInput | dict[str, Any]) -> bool:
        """Bash 命令通常不是并发安全的

        Args:
            input: 输入参数

        Returns:
            False（保守策略）
        """
        # 保守策略：所有 bash 命令都串行执行
        # 未来可以分析命令内容判断是否只读
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema

        Returns:
            JSON Schema
        """
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
        """检查命令是否危险

        参考 claude-code 的实现，检测破坏性操作。

        Args:
            input_params: 工具输入参数

        Returns:
            是否需要确认
        """
        command = input_params.get("command", "").lower()

        # 破坏性文件操作
        destructive_patterns = [
            "rm -rf",
            "rm -fr",
            "rm -r",
            "rm ",  # 删除文件
            "rmdir",
            "unlink",
            "> /dev/null",  # 重定向到 /dev/null
        ]

        # 危险的 git 操作
        git_dangerous = [
            "git push --force",
            "git push -f",
            "git reset --hard",
            "git clean -fd",
            "git branch -d",
            "git branch -D",
            "git rebase",
            "git push",  # 推送到远程
        ]

        # 数据库操作
        database_dangerous = [
            "drop table",
            "drop database",
            "delete from",
            "truncate",
        ]

        # 权限和系统操作
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

        # 包管理（可能影响系统）
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
