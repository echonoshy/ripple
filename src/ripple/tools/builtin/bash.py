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

        Args:
            input_params: 工具输入参数

        Returns:
            是否需要确认
        """
        command = input_params.get("command", "")

        # 危险命令模式
        dangerous_patterns = [
            "rm -rf",
            "rm -fr",
            "rm -r",
            "git push",
            "git push --force",
            "git reset --hard",
            "DROP TABLE",
            "DELETE FROM",
            "sudo",
            "chmod 777",
        ]

        return any(pattern in command for pattern in dangerous_patterns)
