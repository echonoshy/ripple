"""消息类型定义

基于 claude-code 的消息系统，定义 Agent 循环中使用的各种消息类型。
"""

from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class TextBlock(BaseModel):
    """文本内容块"""

    type: Literal["text"]
    text: str


class ToolUseBlock(BaseModel):
    """工具调用块"""

    type: Literal["tool_use"]
    id: str
    name: str
    input: dict[str, Any]


class ToolResultBlock(BaseModel):
    """工具结果块"""

    type: Literal["tool_result"]
    tool_use_id: str
    content: str
    is_error: bool | None = None


ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock


class AssistantMessage(BaseModel):
    """助手消息"""

    type: Literal["assistant"]
    message: dict[str, Any]  # {id, content, usage}
    uuid: str = Field(default_factory=lambda: str(uuid4()))
    api_error: str | None = None
    is_api_error_message: bool = False


class UserMessage(BaseModel):
    """用户消息"""

    type: Literal["user"]
    message: dict[str, Any]  # {content}
    is_meta: bool = False
    source_tool_assistant_uuid: str | None = None
    tool_use_result: str | None = None


class SystemMessage(BaseModel):
    """系统消息"""

    type: Literal["system"]
    content: str
    level: Literal["info", "warning", "error"] = "info"


class ProgressMessage(BaseModel):
    """进度消息"""

    type: Literal["progress"]
    tool_use_id: str
    data: dict[str, Any]


class AttachmentMessage(BaseModel):
    """附件消息"""

    type: Literal["attachment"]
    attachment: dict[str, Any]


Message = AssistantMessage | UserMessage | SystemMessage | ProgressMessage | AttachmentMessage


class StreamEvent(BaseModel):
    """流式事件"""

    type: Literal["stream_chunk", "stream_start", "stream_end"]
    data: dict[str, Any] | None = None


class RequestStartEvent(BaseModel):
    """请求开始事件"""

    type: Literal["stream_request_start"]


class AgentStopEvent(BaseModel):
    """Agent 循环暂停事件，携带暂停原因和元数据"""

    type: Literal["agent_stop"] = "agent_stop"
    stop_reason: str = "completed"
    metadata: dict[str, Any] = Field(default_factory=dict)
