"""工具基类

定义工具的基础接口和类型。
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Dict, Generic, List, Optional, TypeVar

from pydantic import BaseModel

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message

InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT")


@dataclass
class ToolResult(Generic[OutputT]):
    """工具执行结果"""

    data: OutputT
    new_messages: Optional[List[Message]] = None
    context_modifier: Optional[Callable[[ToolUseContext], ToolUseContext]] = None


class Tool(ABC, Generic[InputT, OutputT]):
    """工具基类

    所有工具必须继承此类并实现抽象方法。
    """

    name: str
    description: str = ""
    max_result_size_chars: int = 100_000

    @abstractmethod
    async def call(
        self,
        args: InputT | Dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[OutputT]:
        """执行工具

        Args:
            args: 工具输入参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            工具执行结果
        """
        pass

    @abstractmethod
    def is_concurrency_safe(self, input: InputT | Dict[str, Any]) -> bool:
        """检查是否可以并发执行

        Args:
            input: 工具输入参数

        Returns:
            是否可以并发执行
        """
        pass

    def to_openai_tool(self) -> Dict[str, Any]:
        """转换为 OpenAI 工具定义格式

        Returns:
            OpenAI 工具定义
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self._get_parameters_schema(),
            },
        }

    def _get_parameters_schema(self) -> Dict[str, Any]:
        """获取参数 schema

        子类可以重写此方法提供自定义 schema。

        Returns:
            JSON Schema
        """
        return {
            "type": "object",
            "properties": {},
            "required": [],
        }


class ToolRegistry:
    """工具注册表"""

    def __init__(self):
        self._tools: Dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        """注册工具

        Args:
            tool: 工具实例
        """
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[Tool]:
        """获取工具

        Args:
            name: 工具名称

        Returns:
            工具实例或 None
        """
        return self._tools.get(name)

    def list_tools(self) -> List[Tool]:
        """列出所有工具

        Returns:
            工具列表
        """
        return list(self._tools.values())

    def get_tool_definitions(self) -> List[Dict[str, Any]]:
        """获取所有工具的 OpenAI 定义

        Returns:
            工具定义列表
        """
        return [tool.to_openai_tool() for tool in self._tools.values()]
