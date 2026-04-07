"""Search 工具

使用 DuckDuckGo 进行网络搜索。
"""

from typing import Any, Dict

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tools.base import Tool, ToolResult


class SearchInput(BaseModel):
    """Search 工具输入"""

    query: str = Field(description="搜索查询关键词")
    max_results: int = Field(default=5, description="最大返回结果数量")


class SearchOutput(BaseModel):
    """Search 工具输出"""

    results: str
    count: int


class SearchTool(Tool[SearchInput, SearchOutput]):
    """Search 工具

    使用 DuckDuckGo 进行网络搜索。
    """

    def __init__(self):
        self.name = "Search"
        self.description = "Search the web using DuckDuckGo"
        self.max_result_size_chars = 50_000

    async def call(
        self,
        args: SearchInput | Dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[SearchOutput]:
        """执行搜索

        Args:
            args: 搜索参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            搜索结果
        """
        # 解析输入
        if isinstance(args, dict):
            args = SearchInput(**args)

        try:
            from ddgs import DDGS

            # 执行搜索
            ddgs = DDGS()
            results = list(ddgs.text(args.query, max_results=args.max_results))

            # 格式化结果
            formatted_results = []
            for i, result in enumerate(results, 1):
                title = result.get("title", "No title")
                href = result.get("href", "")
                body = result.get("body", "")

                formatted_results.append(f"{i}. {title}\n   URL: {href}\n   {body}\n")

            output_text = "\n".join(formatted_results) if formatted_results else "No results found"

            output = SearchOutput(
                results=output_text,
                count=len(results),
            )

            return ToolResult(data=output)

        except ImportError:
            output = SearchOutput(
                results="Error: ddgs library not installed. Run: uv add ddgs",
                count=0,
            )
            return ToolResult(data=output)

        except Exception as e:
            from ripple.utils.errors import error_message

            output = SearchOutput(
                results=f"Error performing search: {error_message(e)}",
                count=0,
            )
            return ToolResult(data=output)

    def is_concurrency_safe(self, input: SearchInput | Dict[str, Any]) -> bool:
        """搜索是并发安全的

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
                "query": {
                    "type": "string",
                    "description": "Search query keywords",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return",
                    "default": 5,
                },
            },
            "required": ["query"],
        }
