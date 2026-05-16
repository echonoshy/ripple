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
    model: str = "codex-medium"
    messages: list[ChatMessage]
    stream: bool = False
    max_turns: int | None = None
    session_id: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    # 兼容旧 OpenAI-compatible 调用方；Codex app-server 当前不读取该字段。
    thinking: bool | None = None
    # 说明：messages 中的 role="system" 条目会被提取并作为 "caller system prompt"，
    # 追加到 ripple 默认 system prompt 之后（而非替换）。若本次请求未带任何 system
    # 消息，则清空 session 上记忆的 caller 段，仅使用默认 prompt。


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
    # 调用方自定义 system prompt，会追加在 ripple 默认 prompt 之后，并标注为
    # "Caller Instructions (HIGHEST PRIORITY)" —— 与默认 prompt 冲突时以此为准。
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


# ─── Sandbox 管理 ───


class SandboxInfo(BaseModel):
    """一个 user 的沙箱状态摘要"""

    user_id: str
    workspace_size_bytes: int = 0
    session_count: int = 0
    has_python_venv: bool = False
    has_pnpm_setup: bool = False
    has_lark_cli_config: bool = False
    has_notion_token: bool = False
    has_gogcli_client_config: bool = False
    has_gogcli_login: bool = False


class SandboxListResponse(BaseModel):
    sandboxes: list[SandboxInfo] = []
    count: int = 0


class WorkspaceEntry(BaseModel):
    name: str
    path: str
    kind: Literal["directory", "file"]
    size_bytes: int
    modified_at: str
    is_hidden: bool = False


class WorkspaceListingResponse(BaseModel):
    path: str
    parent_path: str | None = None
    entries: list[WorkspaceEntry] = Field(default_factory=list)


class WorkspaceFilePreviewResponse(BaseModel):
    path: str
    name: str
    size_bytes: int
    modified_at: str
    mime_type: str
    encoding: str
    content: str
    truncated: bool = False


class WorkspaceFileSaveRequest(BaseModel):
    path: str = Field(min_length=1)
    content: str
    expected_modified_at: str | None = None


class WorkspaceAttachmentResponse(BaseModel):
    path: str
    name: str
    mime_type: str
    size: int
    kind: Literal["image", "attachment"]


class GogcliAccountInfo(BaseModel):
    email: str
    alias: str | None = None
    valid: bool | None = None


class GogcliAccountsResponse(BaseModel):
    has_client_config: bool = False
    accounts: list[GogcliAccountInfo] = []
    count: int = 0
    checked: bool = False


# ─── External Agent Runs ───


class AgentRunCreateRequest(BaseModel):
    prompt: str = Field(min_length=1)
    provider: Literal["auto", "codex"] = "codex"
    cwd: str | None = None
    max_runtime_seconds: int = Field(default=1800, ge=1, le=86_400)


class AgentRunSteerRequest(BaseModel):
    prompt: str = Field(min_length=1)


class AgentRunInfo(BaseModel):
    job_id: str
    provider: str
    status: str
    output_file: str | None = None
    events_file: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    exit_code: int | None = None
    prompt_preview: str | None = None
    sandbox_cwd: str | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: str | None = None
    pending_approval: dict[str, Any] | None = None


class AgentRunListResponse(BaseModel):
    runs: list[AgentRunInfo] = Field(default_factory=list)
    count: int = 0


# ─── Internal Users / Quota ───


class UserQuotaUpdateRequest(BaseModel):
    max_workspace_mb: int | None = Field(default=None, ge=0)
    max_sessions: int | None = Field(default=None, ge=0)
    max_runs_per_day: int | None = Field(default=None, ge=0)
    max_run_runtime_seconds: int | None = Field(default=None, ge=0)


class UserQuotaStatusResponse(BaseModel):
    user_id: str
    quota: dict[str, int]
    usage: dict[str, int]


class UserProfileResponse(BaseModel):
    user_id: str
    display_name: str
    created_at: str
    updated_at: str
    quota: dict[str, int]


# ─── Documents ───


class DocumentCreateRequest(BaseModel):
    title: str = Field(min_length=1)
    path: str = Field(min_length=1)
    linked_session_id: str | None = None
    summary: str = ""


class DocumentUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    linked_session_id: str | None = None
    summary: str | None = None


class DocumentInfo(BaseModel):
    document_id: str
    title: str
    path: str
    kind: str
    source: str
    linked_session_id: str | None = None
    summary: str = ""
    created_at: str
    updated_at: str
    last_modified_at: str


class DocumentListResponse(BaseModel):
    documents: list[DocumentInfo] = Field(default_factory=list)
    count: int = 0


# ─── Connectors ───


class ConnectorInfo(BaseModel):
    name: str
    display_name: str
    description: str
    auth_type: str
    auth_start_path: str | None = None
    auth_complete_path: str | None = None
    disconnect_path: str | None = None
    accounts_path: str | None = None


class ConnectorListResponse(BaseModel):
    connectors: list[ConnectorInfo]


class ConnectorStatusResponse(BaseModel):
    name: str
    connected: bool
    required: bool
    detail: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConnectorActionResponse(BaseModel):
    name: str
    ok: bool
    stage: str = ""
    detail: str = ""
    data: dict[str, Any] = Field(default_factory=dict)
