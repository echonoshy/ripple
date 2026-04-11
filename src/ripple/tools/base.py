"""工具基类

定义工具的基础接口和类型。
"""

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message
from ripple.permissions.levels import ToolRiskLevel

InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT")


@dataclass
class ToolResult(Generic[OutputT]):
    """工具执行结果"""

    data: OutputT
    new_messages: list[Message] | None = None
    context_modifier: Callable[[ToolUseContext], ToolUseContext] | None = None


class Tool(ABC, Generic[InputT, OutputT]):
    """工具基类

    所有工具必须继承此类并实现抽象方法。
    """

    name: str
    description: str = ""
    max_result_size_chars: int = 100_000
    risk_level: ToolRiskLevel = ToolRiskLevel.SAFE

    @abstractmethod
    async def call(
        self,
        args: InputT | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[OutputT]:
        """执行工具"""
        pass

    @abstractmethod
    def is_concurrency_safe(self, input: InputT | dict[str, Any]) -> bool:
        """检查是否可以并发执行"""
        pass

    def to_openai_tool(self) -> dict[str, Any]:
        """转换为 OpenAI 工具定义格式"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self._get_parameters_schema(),
            },
        }

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema，子类可重写"""
        return {
            "type": "object",
            "properties": {},
            "required": [],
        }

    def requires_confirmation(self, input_params: dict) -> bool:
        """判断是否需要用户确认（可被子类覆盖）"""
        return self.risk_level == ToolRiskLevel.DANGEROUS
