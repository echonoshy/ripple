"""工具基类

定义工具的基础接口和类型。
"""

import json
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message
from ripple.permissions.levels import ToolRiskLevel

# 日志摘要里的字符串阈值：超过时只记长度，不落原文
_LOG_STR_MAX = 80


def _redact_for_log(value: Any, max_str: int = _LOG_STR_MAX) -> Any:
    """对单个值做日志裁剪

    - ``None`` / ``bool`` / ``int`` / ``float`` 原样返回
    - 短字符串原样返回，超长字符串变成 ``<str:len>``
    - list / dict 若序列化后 <= max_str 原样返回，否则变成 ``<list:len>`` / ``<dict:keys>``
    """
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= max_str:
            return value
        return f"<str:{len(value)}>"
    if isinstance(value, (list, tuple)):
        try:
            rendered = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return f"<{type(value).__name__}:{len(value)}>"
        if len(rendered) <= max_str:
            return value
        return f"<{type(value).__name__}:{len(value)}>"
    if isinstance(value, dict):
        try:
            rendered = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return f"<dict:{sorted(value.keys())}>"
        if len(rendered) <= max_str:
            return value
        return f"<dict:{sorted(value.keys())}>"
    return f"<{type(value).__name__}>"


InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT")


class StopReason:
    """Agent loop 暂停原因"""

    COMPLETED = "completed"
    ASK_USER = "ask_user"
    PERMISSION_REQUEST = "permission_request"


@dataclass
class ToolResult(Generic[OutputT]):
    """工具执行结果"""

    data: OutputT
    new_messages: list[Message] | None = None
    context_modifier: Callable[[ToolUseContext], ToolUseContext] | None = None
    stop_agent_loop: bool = False
    stop_reason: str | None = None


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

    def to_anthropic_tool(self) -> dict[str, Any]:
        """转换为 Anthropic Messages API 工具定义格式"""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self._get_parameters_schema(),
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

    # ─── 日志摘要钩子 ───
    #
    # 工具调用/完成时，orchestration 层只把下面这两个方法返回的小字典落盘，
    # 避免把模型传入的整段 content / 长 shell 输出 / 长文件正文刷进 ripple.log。
    # 完整消息体仍由沙箱 messages.jsonl 负责单一来源地存档，需要时去那里查。

    def log_input_summary(self, input_params: dict[str, Any]) -> dict[str, Any]:
        """工具调用前记录的摘要

        默认实现对每个字段按 :func:`_redact_for_log` 裁剪：短值原样，长值变成 ``<str:len>``。
        子类可覆盖以自定义白名单 / 额外衍生字段（如 bytes、line_count）。
        """
        if not isinstance(input_params, dict):
            return {"input": _redact_for_log(input_params)}
        return {k: _redact_for_log(v) for k, v in input_params.items()}

    def log_result_summary(self, result_data: Any) -> dict[str, Any]:
        """工具完成后记录的摘要（默认：仅记字节长度）

        ``result_data`` 是 :class:`ToolResult` 的 ``data`` 字段。默认实现只打 bytes
        长度，保证大输出不会刷屏。子类可覆盖以提供 exit_code、success 等语义字段。
        """
        if result_data is None:
            return {"bytes": 0}
        if isinstance(result_data, BaseModel):
            rendered = result_data.model_dump_json()
        else:
            rendered = str(result_data)
        return {"bytes": len(rendered)}
