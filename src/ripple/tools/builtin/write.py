"""Write 工具

写入文件内容。
"""

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult


class WriteInput(BaseModel):
    """Write 工具输入"""

    file_path: str = Field(description="要写入的文件路径（绝对路径）")
    content: str = Field(description="要写入的内容")


class WriteOutput(BaseModel):
    """Write 工具输出"""

    success: bool
    message: str
    bytes_written: int


class WriteTool(Tool[WriteInput, WriteOutput]):
    """Write 工具

    写入文件内容，会覆盖现有文件。
    """

    def __init__(self):
        self.name = "Write"
        self.description = "Write content to a file (overwrites existing file)"
        self.max_result_size_chars = 10_000
        self.risk_level = ToolRiskLevel.MODERATE

    async def call(
        self,
        args: WriteInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[WriteOutput]:
        """写入文件

        Args:
            args: 写入参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            写入结果
        """
        # 解析输入
        if isinstance(args, dict):
            args = WriteInput(**args)

        try:
            file_path = Path(args.file_path)

            # 沙箱模式下校验路径在 workspace 范围内
            if context.is_sandboxed:
                from ripple.sandbox.workspace import validate_path

                file_path = validate_path(file_path, context.workspace_root)

            # 创建父目录
            file_path.parent.mkdir(parents=True, exist_ok=True)

            # 写入文件
            with open(file_path, "w", encoding="utf-8") as f:
                bytes_written = f.write(args.content)

            # 磁盘配额检查
            quota_warning = ""
            if context.is_sandboxed:
                from ripple.tools.builtin.bash import _sandbox_config

                if _sandbox_config:
                    from ripple.sandbox.workspace import check_workspace_quota

                    exceeded, size_bytes = check_workspace_quota(_sandbox_config, context.sandbox_session_id)
                    if exceeded:
                        size_mb = size_bytes / (1024 * 1024)
                        quota_warning = (
                            f" [WARNING: workspace size ({size_mb:.1f}MB) exceeds "
                            f"quota ({_sandbox_config.max_workspace_mb}MB)]"
                        )

            output = WriteOutput(
                success=True,
                message=f"Successfully wrote {bytes_written} bytes to {args.file_path}{quota_warning}",
                bytes_written=bytes_written,
            )

            return ToolResult(data=output)

        except Exception as e:
            from ripple.utils.errors import error_message

            output = WriteOutput(
                success=False,
                message=f"Error writing file: {error_message(e)}",
                bytes_written=0,
            )
            return ToolResult(data=output)

    def is_concurrency_safe(self, input: WriteInput | dict[str, Any]) -> bool:
        """写入文件不是并发安全的

        Args:
            input: 输入参数

        Returns:
            False
        """
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema

        Returns:
            JSON Schema
        """
        return {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to write",
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file",
                },
            },
            "required": ["file_path", "content"],
        }

    def requires_confirmation(self, input_params: dict) -> bool:
        """检查是否需要确认

        覆盖现有文件时需要确认。

        Args:
            input_params: 工具输入参数

        Returns:
            是否需要确认
        """
        file_path = input_params.get("file_path", "")
        if not file_path:
            return False

        # 检查文件是否存在
        path = Path(file_path)
        return path.exists() and path.is_file()
