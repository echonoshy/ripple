"""Bash 工具

执行 shell 命令。
"""

import subprocess
from typing import Any, Dict

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult


class BashInput(BaseModel):
    """Bash 工具输入"""

    command: str = Field(description="要执行的 shell 命令")
    timeout: int = Field(default=120, description="超时时间（秒）")


class BashOutput(BaseModel):
    """Bash 工具输出"""

    stdout: str
    stderr: str
    exit_code: int


class BashTool(Tool[BashInput, BashOutput]):
    """Bash 工具

    执行 shell 命令并返回结果。
    """

    def __init__(self):
        self.name = "Bash"
        self.description = "Execute a bash command and return the output"
        self.max_result_size_chars = 100_000
        self.risk_level = ToolRiskLevel.DANGEROUS

    async def call(
        self,
        args: BashInput | Dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[BashOutput]:
        """执行 bash 命令

        Args:
            args: 命令参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            执行结果
        """
        # 解析输入
        if isinstance(args, dict):
            args = BashInput(**args)

        try:
            # 执行命令
            result = subprocess.run(
                args.command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=args.timeout,
                cwd=context.cwd,
            )

            output = BashOutput(
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.returncode,
            )

            return ToolResult(data=output)

        except subprocess.TimeoutExpired:
            output = BashOutput(
                stdout="",
                stderr=f"Command timed out after {args.timeout} seconds",
                exit_code=-1,
            )
            return ToolResult(data=output)

        except Exception as e:
            from ripple.utils.errors import error_message

            output = BashOutput(
                stdout="",
                stderr=f"Command execution failed: {error_message(e)}",
                exit_code=-1,
            )
            return ToolResult(data=output)

    def is_concurrency_safe(self, input: BashInput | Dict[str, Any]) -> bool:
        """Bash 命令通常不是并发安全的

        Args:
            input: 输入参数

        Returns:
            False（保守策略）
        """
        # 保守策略：所有 bash 命令都串行执行
        # 未来可以分析命令内容判断是否只读
        return False

    def _get_parameters_schema(self) -> Dict[str, Any]:
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
