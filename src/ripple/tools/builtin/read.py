"""Read 工具

读取文件内容。
"""

from pathlib import Path
from typing import Any, Dict

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tools.base import Tool, ToolResult


class ReadInput(BaseModel):
    """Read 工具输入"""

    file_path: str = Field(description="要读取的文件路径（绝对路径）")
    offset: int = Field(default=0, description="起始行号（从 0 开始）")
    limit: int = Field(default=2000, description="读取的行数")


class ReadOutput(BaseModel):
    """Read 工具输出"""

    content: str
    total_lines: int
    read_lines: int


class ReadTool(Tool[ReadInput, ReadOutput]):
    """Read 工具

    读取文件内容，支持分页读取。
    """

    def __init__(self):
        self.name = "Read"
        self.description = "Read file contents with optional pagination"
        self.max_result_size_chars = 200_000

    async def call(
        self,
        args: ReadInput | Dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[ReadOutput]:
        """读取文件

        Args:
            args: 读取参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            文件内容
        """
        # 解析输入
        if isinstance(args, dict):
            args = ReadInput(**args)

        try:
            file_path = Path(args.file_path)

            # 检查文件是否存在
            if not file_path.exists():
                raise FileNotFoundError(f"File not found: {args.file_path}")

            # 读取文件
            with open(file_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            total_lines = len(lines)

            # 应用分页
            start = args.offset
            end = min(start + args.limit, total_lines)
            selected_lines = lines[start:end]

            # 添加行号
            numbered_lines = []
            for i, line in enumerate(selected_lines, start=start + 1):
                numbered_lines.append(f"{i}\t{line.rstrip()}")

            content = "\n".join(numbered_lines)

            output = ReadOutput(
                content=content,
                total_lines=total_lines,
                read_lines=len(selected_lines),
            )

            return ToolResult(data=output)

        except Exception as e:
            from ripple.utils.errors import error_message

            output = ReadOutput(
                content=f"Error reading file: {error_message(e)}",
                total_lines=0,
                read_lines=0,
            )
            return ToolResult(data=output)

    def is_concurrency_safe(self, input: ReadInput | Dict[str, Any]) -> bool:
        """读取文件是并发安全的

        Args:
            input: 输入参数

        Returns:
            True
        """
        return True

    def _get_parameters_schema(self) -> Dict[str, Any]:
        """获取参数 schema

        Returns:
            JSON Schema
        """
        return {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to read",
                },
                "offset": {
                    "type": "integer",
                    "description": "Starting line number (0-indexed)",
                    "default": 0,
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of lines to read",
                    "default": 2000,
                },
            },
            "required": ["file_path"],
        }
