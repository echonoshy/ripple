"""OpenAI 兼容的请求/响应 Pydantic 模型"""

import time
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

# ─── Chat Completions 请求 ───


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict[str, Any]] | None = None
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class ChatCompletionRequest(BaseModel):
    model: str = "sonnet"
    messages: list[ChatMessage]
    stream: bool = False
    max_turns: int | None = None
    session_id: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking: bool = False


# ─── Chat Completions 响应（非流式） ───


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: dict[str, Any]
    finish_reason: str | None = "stop"


class UsageInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid4().hex[:24]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str = ""
    choices: list[ChatCompletionChoice] = []
    usage: UsageInfo = Field(default_factory=UsageInfo)


# ─── Chat Completions 响应（流式 SSE chunk） ───


class DeltaContent(BaseModel):
    role: str | None = None
    content: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class StreamChoice(BaseModel):
    index: int = 0
    delta: DeltaContent = Field(default_factory=DeltaContent)
    finish_reason: str | None = None


class ChatCompletionChunk(BaseModel):
    id: str = ""
    object: str = "chat.completion.chunk"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str = ""
    choices: list[StreamChoice] = []
    usage: UsageInfo | None = None


# ─── Models 响应 ───


class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int = Field(default_factory=lambda: int(time.time()))
    owned_by: str = "ripple"


class ModelsResponse(BaseModel):
    object: str = "list"
    data: list[ModelInfo] = []


# ─── Session 管理 ───


class FeishuConfig(BaseModel):
    """飞书应用凭证（per-session）"""

    app_id: str
    app_secret: str
    brand: str = "feishu"


class CreateSessionRequest(BaseModel):
    model: str | None = None
    max_turns: int | None = None
    system_prompt: str | None = None
    feishu: FeishuConfig | None = None


class SessionInfo(BaseModel):
    session_id: str
    title: str = ""
    model: str
    created_at: str
    last_active: str
    message_count: int
    status: str = "active"  # active / suspended
    workspace_size_bytes: int | None = None


class SessionDetailResponse(SessionInfo):
    messages: list[dict[str, Any]] = []
    pending_question: str | None = None
    pending_options: list[str] | None = None
    pending_permission_request: dict[str, Any] | None = None


class PermissionResolveRequest(BaseModel):
    action: Literal["allow", "always", "deny"]


class SessionListResponse(BaseModel):
    sessions: list[SessionInfo]
    count: int


class SuspendedSessionInfo(BaseModel):
    session_id: str
    model: str
    message_count: int
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    created_at: str = ""
    last_active: str = ""
    suspended_at: str = ""


# ─── System Info ───


class SystemInfoResponse(BaseModel):
    tools: list[str] = []
    skills: list[dict[str, str]] = []
    model_presets: dict[str, str] = {}
    default_model: str = ""
    max_turns: int = 10


# ─── Tools Invoke ───


class ToolInvokeRequest(BaseModel):
    tool: str
    args: dict[str, Any] = {}
    session_id: str | None = None


class ToolInvokeResponse(BaseModel):
    ok: bool = True
    result: Any = None
    error: str | None = None
