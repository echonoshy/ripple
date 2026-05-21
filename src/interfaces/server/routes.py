"""API 路由定义

包含 chat completions、models、health、sessions、connectors、workspace、sandbox
以及 Codex app-server run 管理端点。
"""

import html
import json
import time
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from interfaces.server.attachments import (
    detect_mime_type,
    host_path_for_workspace_path,
    is_image_mime_type,
    save_uploaded_attachment,
)
from interfaces.server.auth import verify_api_key
from interfaces.server.codex_chat import (
    _append_session_assistant_message,
    _append_session_messages,
    collect_codex_chat_response,
    stream_codex_chat_as_sse,
)
from interfaces.server.connector_chat_auth import maybe_handle_connector_chat_auth, poll_pending_connector_chat_auth
from interfaces.server.deps import get_user_id
from interfaces.server.run_events import stream_run_events
from interfaces.server.schedule_chat import (
    SCHEDULE_EXTRACTION_MAX_RUNTIME_SECONDS,
    SCHEDULE_EXTRACTION_OUTPUT_SCHEMA,
    agent_stop_ask_user_event,
    build_schedule_cancelled_message,
    build_schedule_created_message,
    build_schedule_extraction_prompt,
    build_schedule_pending_message,
    is_schedule_cancellation,
    is_schedule_confirmation,
    is_schedule_intent,
    parse_schedule_extraction_output,
    schedule_cancelled_event,
    schedule_clarification_event,
    schedule_created_event,
    schedule_extraction_clarification,
    schedule_extraction_failed_event,
    schedule_pending_event,
    schedule_proposal_event,
    schedule_proposal_from_extraction,
)
from interfaces.server.schemas import (
    AgentRunCreateRequest,
    AgentRunInfo,
    AgentRunListResponse,
    AgentRunSteerRequest,
    ChatCompletionRequest,
    ConnectorActionResponse,
    ConnectorAuthPollRequest,
    ConnectorInfo,
    ConnectorListResponse,
    ConnectorStatusResponse,
    CreateSessionRequest,
    DocumentCreateRequest,
    DocumentInfo,
    DocumentListResponse,
    DocumentUpdateRequest,
    GogcliAccountInfo,
    GogcliAccountsResponse,
    ModelInfo,
    ModelsResponse,
    PermissionResolveRequest,
    SandboxInfo,
    ScheduleCreateRequest,
    ScheduleInfo,
    ScheduleListResponse,
    ScheduleRunListResponse,
    ScheduleUpdateRequest,
    SessionDetailResponse,
    SessionInfo,
    SessionListResponse,
    SuspendedSessionInfo,
    SystemInfoResponse,
    UserProfileResponse,
    UserQuotaStatusResponse,
    UserQuotaUpdateRequest,
    WorkspaceAttachmentResponse,
    WorkspaceEntry,
    WorkspaceFileSaveRequest,
    WorkspaceRenameRequest,
    WorkspaceSearchResponse,
    WorkspaceUploadResponse,
)
from interfaces.server.sessions import Session, SessionManager, SessionStatus, _merge_system_prompt
from interfaces.server.workspace_browser import (
    BinaryFileError,
    WorkspaceFileConflictError,
    WorkspaceFileTooLargeError,
    WorkspaceUploadConflictError,
    WorkspaceUploadItem,
    browse_workspace_directory,
    preview_workspace_file,
    rename_workspace_entry,
    save_workspace_text_file,
    save_workspace_uploaded_files,
    search_workspace_files,
)
from ripple.agent_runners.job_store import find_user_job_record, list_user_job_records
from ripple.agent_runners.manager import ExternalAgentManager, get_external_agent_manager
from ripple.agent_runners.models import AgentRunnerStatus
from ripple.agent_runners.service import start_agent_run
from ripple.connectors.base import ConnectorActionResult, ConnectorUnsupportedError
from ripple.connectors.registry import complete_google_workspace_oauth_callback, list_connectors
from ripple.connectors.registry import get_connector as get_registered_connector
from ripple.documents.store import (
    create_document,
    delete_document,
    get_document,
    list_documents,
    update_document,
)
from ripple.messages.utils import serialize_messages
from ripple.sandbox.storage import extract_title_from_messages
from ripple.sandbox.workspace import validate_path
from ripple.schedules import (
    create_schedule,
    delete_schedule,
    get_schedule,
    list_schedule_run_records,
    list_schedules,
    trigger_schedule_now,
    update_schedule,
)
from ripple.users.quota import (
    assert_can_create_run,
    assert_can_create_session,
    assert_workspace_save_within_quota,
    quota_status,
)
from ripple.users.store import ensure_user_record, update_user_quota
from ripple.utils.config import Config, get_config
from ripple.utils.logger import get_logger, set_current_session_id

logger = get_logger("server.routes")

router = APIRouter()

_session_manager: SessionManager | None = None


def get_session_manager() -> SessionManager:
    if _session_manager is None:
        raise RuntimeError("SessionManager not initialized")
    return _session_manager


def set_session_manager(manager: SessionManager):
    global _session_manager
    _session_manager = manager


def _display_model(raw_id: str) -> str:
    """把存储层的 raw model ID 反映射回前端友好的别名

    前端下拉菜单用的是 "codex-medium" 这类 alias，但历史 session 里可能
    保存的是某个 provider 的 raw ID。直接透传给前端会导致下拉框选中状态丢失。

    反查策略：如果 raw_id 命中任何 preset 的 provider 值，返回对应 alias；
    否则原样返回（兼容自定义 model）。
    """
    if not raw_id:
        return raw_id
    alias = get_config().alias_for_model(raw_id)
    return alias or raw_id


def _session_status(session_status: str | None, pending_permission_request: dict[str, Any] | None = None) -> str:
    if pending_permission_request:
        return "waiting_for_approval"

    normalized = (session_status or "").strip().lower()
    return {
        SessionStatus.IDLE: "idle",
        SessionStatus.RUNNING: "running",
        SessionStatus.AWAITING_USER_INPUT: "waiting_for_user",
        SessionStatus.AWAITING_PERMISSION: "waiting_for_approval",
        "active": "idle",
        "suspended": "idle",
        "queued": "queued",
        "waiting_for_user": "waiting_for_user",
        "waiting_for_approval": "waiting_for_approval",
        "review": "review",
        "completed": "completed",
        "error": "failed",
        "failed": "failed",
        "cancelled": "cancelled",
        "canceled": "cancelled",
    }.get(normalized, "idle")


def _session_info_from_record(record: dict[str, Any]) -> SessionInfo:
    session_id = str(record.get("session_id") or "")
    pending_permission_request = record.get("pending_permission_request")
    if not isinstance(pending_permission_request, dict):
        pending_permission_request = None
    return SessionInfo(
        session_id=session_id,
        title=str(record.get("title") or ""),
        model=_display_model(str(record.get("model") or "")),
        created_at=str(record.get("created_at") or ""),
        last_active=str(record.get("last_active") or ""),
        message_count=int(record.get("message_count") or 0),
        status=_session_status(str(record.get("status") or ""), pending_permission_request),
        changed_file_count=0,
        pending_approval_count=1 if pending_permission_request else 0,
    )


def _session_info_from_session(session: Session) -> SessionInfo:
    pending_permission_request = session.pending_permission_request
    return SessionInfo(
        session_id=session.session_id,
        title=extract_title_from_messages(session.messages),
        model=_display_model(session.model),
        created_at=session.created_at.isoformat(),
        last_active=session.last_active.isoformat(),
        message_count=len(session.messages),
        status=_session_status(session.status, pending_permission_request),
        changed_file_count=0,
        pending_approval_count=1 if pending_permission_request else 0,
    )


def _session_detail_from_session(session: Session) -> SessionDetailResponse:
    return SessionDetailResponse(
        **_session_info_from_session(session).model_dump(),
        messages=serialize_messages(session.messages),
        pending_question=session.pending_question,
        pending_options=session.pending_options,
        pending_permission_request=session.pending_permission_request,
        pending_schedule_request=session.pending_schedule_request,
        plan_steps=session.plan_steps,
        plan_progress=session.plan_progress,
        task_steps=session.plan_steps,
        task_progress=session.plan_progress,
    )


def _get_or_resume_session(manager: SessionManager, session_id: str, *, user_id: str) -> Session | None:
    session = manager.get_session(session_id, user_id=user_id)
    if not session:
        session = manager.resume_session(session_id, user_id=user_id)
    return session


async def _resolve_session_permission(
    manager: SessionManager,
    session: Session,
    request: PermissionResolveRequest,
) -> dict[str, Any]:
    permission_request = session.pending_permission_request
    if not permission_request:
        raise HTTPException(status_code=409, detail="No pending permission request")

    async with session.lock:
        if permission_request.get("source") != "codex":
            raise HTTPException(
                status_code=410,
                detail="Legacy Ripple tool permission replay has been removed. Only Codex approvals are supported.",
            )

        job_id = permission_request.get("job_id")
        request_id = permission_request.get("request_id")
        if not isinstance(job_id, str) or not job_id:
            raise HTTPException(status_code=400, detail="Codex permission request is missing job_id")
        if request_id is None:
            raise HTTPException(status_code=400, detail="Codex permission request is missing request_id")

        forwarded = get_external_agent_manager().resolve_approval(job_id, request_id, request.action)
        if not forwarded:
            raise HTTPException(status_code=409, detail="Codex approval request is no longer pending")

        session.pending_permission_request = None
        session.pending_question = None
        session.pending_options = None
        session.status = SessionStatus.RUNNING
        manager.touch_session(session)
        manager.persist_session(session)

    return {"ok": True, "action": request.action, "forwarded": True}


async def _clear_session_context(manager: SessionManager, session: Session) -> None:
    async with session.lock:
        if session.current_task and not session.current_task.done():
            raise HTTPException(status_code=409, detail="Session is currently running")

        session.messages.clear()
        session.model_messages.clear()
        session.pending_question = None
        session.pending_options = None
        session.pending_permission_request = None
        session.pending_connector_auth = None
        session.pending_schedule_request = None
        session.codex_thread_id = None
        session.plan_steps = []
        session.plan_progress = None
        session.last_input_tokens = 0
        session.total_input_tokens = 0
        session.total_output_tokens = 0
        session.status = SessionStatus.IDLE
        manager.touch_session(session)
        manager.persist_session(session)


# ─── Health ───


@router.get("/health")
async def health():
    return {"status": "ok", "timestamp": int(time.time())}


# ─── Models ───


@router.get("/v1/models")
async def list_models(_api_key: str = Depends(verify_api_key)):
    config = get_config()
    presets = config.get_model_presets()
    models = []
    for alias, info in (presets or {}).items():
        models.append(
            ModelInfo(
                id=alias,
                owned_by="ripple",
            )
        )
    return ModelsResponse(data=models)


# ─── System Info ───


@router.get("/v1/info")
async def get_system_info(_api_key: str = Depends(verify_api_key)):
    """返回系统信息：可用工具、技能、模型预设"""
    config = get_config()

    from interfaces.server.sessions import get_server_tool_names
    from ripple.skills.loader import load_shared_skills

    tool_names = get_server_tool_names()

    skills_dict = load_shared_skills()
    skills = [{"name": s.name, "description": s.description[:150]} for s in skills_dict.values()]

    model_presets = config.presets_for_provider()

    return SystemInfoResponse(
        tools=tool_names,
        skills=skills,
        model_presets=model_presets,
        default_model=config.get("model.default", "codex-medium"),
        max_turns=config.get("agent.max_turns", 10),
    )


# ─── Chat Completions ───


def _extract_user_input(request: ChatCompletionRequest) -> str:
    """从 OpenAI 格式的 messages 中提取最后一条用户消息的文本。"""
    text, _input_items, _user_content = _extract_user_input_and_items(request, workspace_root=None)
    return text


def _extract_user_input_and_items(
    request: ChatCompletionRequest,
    *,
    workspace_root: Path | None,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract user text plus Codex-native image items from the last user message."""
    for msg in reversed(request.messages):
        if msg.role != "user":
            continue
        if isinstance(msg.content, str):
            text = msg.content
            content = [{"type": "text", "text": text}] if text.strip() else []
            return text, [], content
        if not isinstance(msg.content, list):
            return "", [], []

        texts: list[str] = []
        input_items: list[dict[str, Any]] = []
        user_content: list[dict[str, Any]] = []
        for block in msg.content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = str(block.get("text") or "")
                if text:
                    texts.append(text)
                    user_content.append({"type": "text", "text": text})
                continue
            if block_type in {"image_url", "input_image"}:
                url = _image_url_from_block(block)
                if url:
                    input_items.append({"type": "image", "url": url})
                    user_content.append({"type": "image", "url": url})
                continue
            if block_type == "file":
                file_item = _input_item_from_file_block(block, workspace_root=workspace_root)
                if file_item is None:
                    continue
                input_items.append(file_item)
                user_content.append(_user_content_for_file_item(file_item))

        return "\n".join(texts), input_items, user_content
    return "", [], []


def _image_url_from_block(block: dict[str, Any]) -> str | None:
    image_url = block.get("image_url")
    if image_url is None:
        image_url = block.get("imageUrl")
    if isinstance(image_url, dict):
        url = image_url.get("url") or image_url.get("image_url") or image_url.get("imageUrl")
    else:
        url = image_url
    return url if isinstance(url, str) and url else None


def _input_item_from_file_block(
    block: dict[str, Any],
    *,
    workspace_root: Path | None,
) -> dict[str, Any] | None:
    file_info = block.get("file")
    if not isinstance(file_info, dict):
        return None

    path = file_info.get("path")
    if not isinstance(path, str) or not path:
        return None
    name = str(file_info.get("name") or Path(path).name)
    mime_type = detect_mime_type(name, str(file_info.get("mime_type") or file_info.get("mimeType") or ""))
    if path.startswith("/workspace/"):
        if workspace_root is None:
            raise PermissionError("workspace is unavailable")
        host_path = host_path_for_workspace_path(workspace_root, path)
        if not host_path.exists() or not host_path.is_file():
            raise FileNotFoundError(path)
        if is_image_mime_type(mime_type):
            return {
                "type": "localImage",
                "path": str(host_path),
                "workspace_path": path,
                "name": name,
                "mime_type": mime_type,
            }
        return {
            "type": "attachment",
            "path": str(host_path),
            "workspace_path": path,
            "name": name,
            "mime_type": mime_type,
        }

    url = file_info.get("url")
    if isinstance(url, str) and url and is_image_mime_type(mime_type):
        return {"type": "image", "url": url, "name": name, "mime_type": mime_type}
    return None


def _user_content_for_file_item(item: dict[str, Any]) -> dict[str, Any]:
    item_type = item.get("type")
    if item_type == "localImage":
        return {
            "type": "localImage",
            "path": item.get("workspace_path"),
            "name": item.get("name"),
            "mime_type": item.get("mime_type"),
        }
    if item_type == "attachment":
        return {
            "type": "attachment",
            "path": item.get("workspace_path"),
            "name": item.get("name"),
            "mime_type": item.get("mime_type"),
        }
    if item_type == "image":
        return {"type": "image", "url": item.get("url")}
    return dict(item)


def _extract_caller_system_prompt(request: ChatCompletionRequest) -> str | None:
    """从 OpenAI 格式的 messages 中收集所有 role=system 的内容，按顺序拼接

    返回值语义：
    - 至少有一条非空 system 消息 → 返回拼接后的字符串
    - 没有或全部为空 → 返回 None（调用方视为"未传"，会清空 session 上的 caller 段）
    """
    parts: list[str] = []
    for msg in request.messages:
        if msg.role != "system":
            continue
        if isinstance(msg.content, str):
            if msg.content.strip():
                parts.append(msg.content)
        elif isinstance(msg.content, list):
            for b in msg.content:
                if isinstance(b, dict) and b.get("type") == "text":
                    text = b.get("text", "")
                    if text.strip():
                        parts.append(text)
    if not parts:
        return None
    return "\n\n".join(parts)


def _request_public_base_url(request: Request) -> str | None:
    from ripple.sandbox.gogcli_oauth import gogcli_oauth_request_base_url  # noqa: PLC0415

    return gogcli_oauth_request_base_url(dict(request.headers), str(request.url))


def _codex_chat_max_runtime_seconds(config) -> int:
    return int(
        config.get(
            "server.codex_chat.max_runtime_seconds",
            config.get("external_agents.codex.max_runtime_seconds", 3600),
        )
        or 3600
    )


def _public_connector_auth_event(event: dict[str, Any]) -> dict[str, Any]:
    hidden_keys = {"user_content", "resume_user_input"}
    public_event = {key: value for key, value in event.items() if key not in hidden_keys and value is not None}
    action = public_event.get("action")
    if isinstance(action, dict):
        data = action.get("data")
        if isinstance(data, dict) and "device_code" in data:
            action = {**action, "data": {key: value for key, value in data.items() if key != "device_code"}}
            public_event["action"] = action
    return public_event


def _connector_auth_resume_user_input(event: dict[str, Any]) -> str:
    value = event.get("resume_user_input")
    return value if isinstance(value, str) and value.strip() else ""


def _connector_auth_status(event: dict[str, Any]) -> str:
    if event.get("type") == "connector_auth_required":
        return SessionStatus.AWAITING_USER_INPUT
    return SessionStatus.IDLE


async def _clear_pending_connector_auth_sessions(
    manager: Any,
    *,
    user_id: str,
    connector_name: str,
) -> int:
    list_sessions = getattr(manager, "list_sessions", None)
    if not callable(list_sessions):
        return 0

    cleared = 0
    for session in list_sessions(user_id=user_id):
        pending = session.pending_connector_auth
        if not isinstance(pending, dict) or pending.get("connector") != connector_name:
            continue
        async with session.lock:
            pending = session.pending_connector_auth
            if not isinstance(pending, dict) or pending.get("connector") != connector_name:
                continue
            if isinstance(pending.get("resume_user_input"), str) and pending["resume_user_input"].strip():
                session.pending_connector_auth = {**pending, "stage": "authorized"}
            else:
                session.pending_connector_auth = None
            if session.status == SessionStatus.AWAITING_USER_INPUT:
                session.status = SessionStatus.IDLE
            manager.touch_session(session)
            manager.persist_session(session)
            cleared += 1
    return cleared


async def _clear_connector_auth_if_connected(
    *,
    manager: Any,
    config: Any,
    connector: Any,
    user_id: str,
    result: ConnectorActionResult | None = None,
) -> int:
    if result is not None and not (result.ok and result.stage == "authorized"):
        return 0

    try:
        if result is None and not connector.status(config, user_id).connected:
            return 0
    except Exception:  # noqa: BLE001
        return 0

    cleared = await _clear_pending_connector_auth_sessions(
        manager,
        user_id=user_id,
        connector_name=connector.info.name,
    )
    if cleared:
        logger.info(
            "event=connector.pending_auth.clear target_user={} connector={} sessions={}",
            user_id,
            connector.info.name,
            cleared,
        )
    return cleared


async def _persist_connector_auth_chat_event(
    *,
    manager: SessionManager,
    session: Session,
    user_input: str,
    user_content: list[dict[str, Any]],
    event: dict[str, Any],
    persist_user_message: bool = True,
) -> dict[str, Any]:
    public_event = _public_connector_auth_event(event)
    assistant_text = str(event.get("message") or "")
    persisted_user_content = event.get("user_content") if isinstance(event.get("user_content"), list) else user_content
    async with session.lock:
        if session.current_task is not None and not session.current_task.done():
            raise HTTPException(status_code=409, detail="Session already has a running task")
        session.status = _connector_auth_status(event)
        session.pending_question = None
        session.pending_options = None
        session.pending_permission_request = None
        if persist_user_message:
            _append_session_messages(session, user_input, assistant_text, user_content=persisted_user_content)
        elif assistant_text:
            _append_session_assistant_message(session, assistant_text)
        manager.touch_session(session)
        manager.persist_session(session)
    return public_event


def _public_chat_event(event: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in event.items() if key != "user_content" and value is not None}


async def _persist_control_plane_chat_event(
    *,
    manager: SessionManager,
    session: Session,
    user_input: str,
    user_content: list[dict[str, Any]],
    event: dict[str, Any],
    status: str = SessionStatus.IDLE,
    clear_pending_schedule: bool = False,
    pending_schedule_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    public_event = _public_chat_event(event)
    assistant_text = str(event.get("message") or "")
    persisted_user_content = event.get("user_content") if isinstance(event.get("user_content"), list) else user_content
    async with session.lock:
        if session.current_task is not None and not session.current_task.done():
            raise HTTPException(status_code=409, detail="Session already has a running task")
        session.status = status
        if status == SessionStatus.AWAITING_USER_INPUT:
            question = event.get("question")
            options = event.get("options")
            session.pending_question = question if isinstance(question, str) else None
            session.pending_options = options if isinstance(options, list) else None
        else:
            session.pending_question = None
            session.pending_options = None
        session.pending_permission_request = None
        if clear_pending_schedule:
            session.pending_schedule_request = None
        elif pending_schedule_request is not None:
            session.pending_schedule_request = pending_schedule_request
        _append_session_messages(session, user_input, assistant_text, user_content=persisted_user_content)
        manager.touch_session(session)
        manager.persist_session(session)
    return public_event


async def _control_plane_chat_response(
    *,
    manager: SessionManager,
    session: Session,
    request: ChatCompletionRequest,
    user_input: str,
    user_content: list[dict[str, Any]],
    model: str,
    event: dict[str, Any],
    status: str = SessionStatus.IDLE,
    clear_pending_schedule: bool = False,
    pending_schedule_request: dict[str, Any] | None = None,
):
    public_event = await _persist_control_plane_chat_event(
        manager=manager,
        session=session,
        user_input=user_input,
        user_content=user_content,
        event=event,
        status=status,
        clear_pending_schedule=clear_pending_schedule,
        pending_schedule_request=pending_schedule_request,
    )
    assistant_text = str(event.get("message") or "")
    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    if request.stream:

        async def stream():
            role_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(role_chunk, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps(public_event, ensure_ascii=False)}\n\n"
            question = public_event.get("question")
            options = public_event.get("options")
            if isinstance(question, str):
                schedule = public_event.get("schedule")
                schedule_metadata = schedule if isinstance(schedule, dict) else None
                option_values = options if isinstance(options, list) else []
                stop_event = agent_stop_ask_user_event(
                    assistant_text,
                    question,
                    option_values,
                    schedule_metadata,
                )
                yield (f"data: {json.dumps(stop_event, ensure_ascii=False)}\n\n")
            content_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": assistant_text}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"
            finish_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
            yield f"data: {json.dumps(finish_chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )

    return {
        "id": chunk_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": assistant_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "session_id": session.session_id,
        "event": public_event,
    }


async def _connector_auth_chat_response(
    *,
    manager: SessionManager,
    session: Session,
    request: ChatCompletionRequest,
    user_input: str,
    user_content: list[dict[str, Any]],
    model: str,
    event: dict[str, Any],
    persist_user_message: bool = True,
):
    public_event = await _persist_connector_auth_chat_event(
        manager=manager,
        session=session,
        user_input=user_input,
        user_content=user_content,
        event=event,
        persist_user_message=persist_user_message,
    )
    assistant_text = str(event.get("message") or "")
    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    if request.stream:

        async def stream():
            role_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(role_chunk, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps(public_event, ensure_ascii=False)}\n\n"
            content_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": assistant_text}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"
            finish_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
            yield f"data: {json.dumps(finish_chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )

    return {
        "id": chunk_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": assistant_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "session_id": session.session_id,
        "connector_auth": public_event,
    }


async def _resume_after_connector_auth_chat_response(
    *,
    manager: SessionManager,
    session: Session,
    request: ChatCompletionRequest,
    auth_user_input: str,
    auth_user_content: list[dict[str, Any]],
    resume_user_input: str,
    model: str,
    effort: str | None,
    summary: str | None,
    output_schema: dict[str, Any] | None,
    system_prompt: str | None,
    agent_manager: ExternalAgentManager,
    config: Config,
    event: dict[str, Any],
    persist_user_message: bool = True,
):
    public_event = await _persist_connector_auth_chat_event(
        manager=manager,
        session=session,
        user_input=auth_user_input,
        user_content=auth_user_content,
        event=event,
        persist_user_message=persist_user_message,
    )
    if request.stream:
        chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
        created = int(time.time())
        assistant_text = str(event.get("message") or "")

        async def stream():
            role_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(role_chunk, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps(public_event, ensure_ascii=False)}\n\n"
            if assistant_text:
                content_chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": assistant_text + "\n\n"}, "finish_reason": None}],
                }
                yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'new_turn'}, ensure_ascii=False)}\n\n"
            async for chunk in stream_codex_chat_as_sse(
                session=session,
                user_input=resume_user_input,
                input_items=[],
                user_content=[{"type": "text", "text": resume_user_input}],
                attachment_items=[],
                model=model,
                effort=effort,
                summary=summary,
                output_schema=output_schema,
                system_prompt=system_prompt,
                manager=manager,
                agent_manager=agent_manager,
                config=config,
                persist_user_message=False,
            ):
                yield chunk

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )

    response = await collect_codex_chat_response(
        session=session,
        user_input=resume_user_input,
        input_items=[],
        user_content=[{"type": "text", "text": resume_user_input}],
        attachment_items=[],
        model=model,
        effort=effort,
        summary=summary,
        output_schema=output_schema,
        system_prompt=system_prompt,
        manager=manager,
        agent_manager=agent_manager,
        config=config,
        persist_user_message=False,
    )
    response["connector_auth"] = public_event
    return response


async def _connector_auth_event_response(
    *,
    manager: SessionManager,
    session: Session,
    request: ChatCompletionRequest,
    model: str,
    event: dict[str, Any],
):
    public_event = _public_connector_auth_event(event)
    async with session.lock:
        if session.current_task is not None and not session.current_task.done():
            raise HTTPException(status_code=409, detail="Session already has a running task")
        session.status = _connector_auth_status(event)
        session.pending_question = None
        session.pending_options = None
        session.pending_permission_request = None
        manager.touch_session(session)
        manager.persist_session(session)

    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    if request.stream:

        async def stream():
            role_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(role_chunk, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps(public_event, ensure_ascii=False)}\n\n"
            finish_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
            yield f"data: {json.dumps(finish_chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )

    return {
        "id": chunk_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": ""},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "session_id": session.session_id,
        "connector_auth": public_event,
    }


def _connector_auth_poll_should_persist_message(
    event: dict[str, Any],
    previous_pending: dict[str, Any],
) -> bool:
    stage = str(event.get("stage") or "")
    if event.get("type") == "connector_auth_updated":
        return True
    if stage in {"auth_failed", "invalid_request"}:
        return True

    action = event.get("action")
    data = action.get("data") if isinstance(action, dict) else None
    if not isinstance(data, dict):
        return False
    if data.get("device_code_finalized") is True:
        return True

    for key in ("setup_url", "oauth_url"):
        value = data.get(key)
        if isinstance(value, str) and value and value != previous_pending.get(key):
            return True
    return False


def _chat_request_from_connector_auth_poll(
    session_id: str,
    request: ConnectorAuthPollRequest,
) -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model=request.model,
        messages=[{"role": "user", "content": ""}],
        stream=request.stream,
        session_id=session_id,
        effort=request.effort,
        summary=request.summary,
        output_schema=request.output_schema,
    )


async def _maybe_handle_pending_schedule_confirmation(
    *,
    manager: SessionManager,
    session: Session,
    request: ChatCompletionRequest,
    user_input: str,
    user_content: list[dict[str, Any]],
    model: str,
):
    pending = session.pending_schedule_request
    if not isinstance(pending, dict):
        return None

    if is_schedule_cancellation(user_input):
        message = build_schedule_cancelled_message(pending)
        return await _control_plane_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=model,
            event=schedule_cancelled_event(message),
            clear_pending_schedule=True,
        )

    if is_schedule_confirmation(user_input):
        if not manager.sandbox_manager:
            raise HTTPException(status_code=500, detail="sandbox disabled")
        manager.sandbox_manager.ensure_sandbox(session.user_id)
        try:
            record = create_schedule(manager.sandbox_manager.config, session.user_id, pending)
        except ValueError as exc:
            async with session.lock:
                session.pending_schedule_request = None
                session.pending_question = None
                session.pending_options = None
                if session.status == SessionStatus.AWAITING_USER_INPUT:
                    session.status = SessionStatus.IDLE
                manager.touch_session(session)
                manager.persist_session(session)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        message = build_schedule_created_message(record)
        return await _control_plane_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=model,
            event=schedule_created_event(record, message),
            clear_pending_schedule=True,
        )

    message = build_schedule_pending_message(pending)
    return await _control_plane_chat_response(
        manager=manager,
        session=session,
        request=request,
        user_input=user_input,
        user_content=user_content,
        model=model,
        event=schedule_pending_event(message, pending),
        status=SessionStatus.AWAITING_USER_INPUT,
    )


def _schedule_extraction_max_runtime_seconds(config) -> int:
    return int(
        config.get("server.schedule_extraction.max_runtime_seconds", SCHEDULE_EXTRACTION_MAX_RUNTIME_SECONDS) or 120
    )


def _read_agent_result_text(result) -> str:
    if result is None:
        return ""
    output_file = getattr(result, "output_file", None)
    if output_file and Path(output_file).exists():
        return Path(output_file).read_text(encoding="utf-8")
    return str(getattr(result, "stdout_tail", "") or "")


async def _extract_schedule_with_codex(
    *,
    session: Session,
    user_input: str,
    model: str,
    effort: str | None,
    manager: SessionManager,
    agent_manager,
    config,
) -> Any:
    if session.context is None or session.context.workspace_root is None or manager.sandbox_manager is None:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = session.context.workspace_root
    runtime_dir = session.context.session_runtime_dir or workspace_root.parent / "agent-runs"
    max_runtime_seconds = _schedule_extraction_max_runtime_seconds(config)
    assert_can_create_run(manager.sandbox_manager.config, session.user_id, max_runtime_seconds)
    prompt = build_schedule_extraction_prompt(user_input)
    job = start_agent_run(
        prompt=prompt,
        input_items=[{"type": "text", "text": prompt}],
        model=model,
        effort=effort,
        summary=None,
        output_schema=SCHEDULE_EXTRACTION_OUTPUT_SCHEMA,
        provider_name="codex",
        raw_cwd="/workspace",
        max_runtime_seconds=max_runtime_seconds,
        user_id=session.user_id,
        session_id=session.session_id,
        workspace_root=workspace_root,
        runtime_dir=runtime_dir,
        manager=agent_manager,
        sandbox_config=manager.sandbox_manager.config,
        require_agent_route=False,
    )
    result = await agent_manager.wait(job.job_id)
    if result is None or result.status != AgentRunnerStatus.COMPLETED:
        error = result.error if result else "Codex schedule extraction disappeared"
        raise RuntimeError(error or "Codex schedule extraction failed")
    return parse_schedule_extraction_output(_read_agent_result_text(result))


async def _maybe_handle_schedule_creation_request(
    *,
    manager: SessionManager,
    session: Session,
    request: ChatCompletionRequest,
    user_input: str,
    user_content: list[dict[str, Any]],
    model: str,
    effort: str | None,
    agent_manager,
    config,
):
    if not is_schedule_intent(user_input):
        return None

    try:
        extraction = await _extract_schedule_with_codex(
            session=session,
            user_input=user_input,
            model=model,
            effort=effort,
            manager=manager,
            agent_manager=agent_manager,
            config=config,
        )
    except ValueError as exc:
        logger.warning("Schedule extraction returned invalid data: {}", exc)
        message = "定时任务解析结果不合法，不是你的描述问题。请稍后重试。"
        return await _control_plane_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=model,
            event=schedule_extraction_failed_event(message),
        )
    except RuntimeError as exc:
        logger.warning("Schedule extraction run failed: {}", exc)
        message = "定时任务解析服务失败，不是你的描述问题。请稍后重试。"
        return await _control_plane_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=model,
            event=schedule_extraction_failed_event(message),
        )

    if not extraction.is_schedule_request:
        return None

    clarification = schedule_extraction_clarification(extraction)
    if clarification:
        return await _control_plane_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=model,
            event=schedule_clarification_event(clarification),
            status=SessionStatus.AWAITING_USER_INPUT,
        )

    try:
        proposal = schedule_proposal_from_extraction(extraction)
    except ValueError as exc:
        logger.warning("Schedule extraction failed validation: {}", exc)
        return await _control_plane_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=model,
            event=schedule_clarification_event("这个定时任务还缺少有效的时间或执行内容，请补充后我再创建。"),
            status=SessionStatus.AWAITING_USER_INPUT,
        )
    if proposal is None:
        return None

    return await _control_plane_chat_response(
        manager=manager,
        session=session,
        request=request,
        user_input=user_input,
        user_content=user_content,
        model=model,
        event=schedule_proposal_event(proposal),
        status=SessionStatus.AWAITING_USER_INPUT,
        pending_schedule_request=proposal.payload,
    )


def _resolve_agent_run_turn_config(request: AgentRunCreateRequest) -> tuple[str | None, str | None]:
    if not request.model:
        return None, request.effort

    config = get_config()
    presets = config.get_model_presets()
    if request.model in presets:
        resolved = config.resolve_model_info(request.model)
        return resolved.model, request.effort or resolved.reasoning_effort
    return request.model, request.effort


@router.post("/v1/chat/completions")
async def chat_completions(
    request: ChatCompletionRequest,
    http_request: Request,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    config = get_config()

    max_turns = request.max_turns or config.get("agent.max_turns", 10)
    caller_system_prompt = _extract_caller_system_prompt(request)
    if manager.sandbox_manager:
        manager.sandbox_manager.ensure_sandbox(user_id)
        assert_can_create_run(manager.sandbox_manager.config, user_id, _codex_chat_max_runtime_seconds(config))

    session = None
    is_new = False
    if request.session_id:
        session = manager.get_session(request.session_id, user_id=user_id)
        if not session:
            session = manager.resume_session(request.session_id, user_id=user_id)
    if session is None:
        if manager.sandbox_manager:
            manager.sandbox_manager.ensure_sandbox(user_id)
            assert_can_create_session(manager.sandbox_manager.config, user_id)
        session = manager.create_session(
            user_id=user_id,
            model=request.model,
            max_turns=max_turns,
            caller_system_prompt=caller_system_prompt,
        )
        is_new = True
    set_current_session_id(session.session_id)
    resolved_model = manager.configure_session_model(session, request.model)
    resolved_effort = request.effort
    if resolved_effort is None and session.context is not None:
        resolved_effort = session.context.options.reasoning_effort

    # 对已存在的 session：本轮带了 system 就覆盖，没带就清空 caller 段（仅默认 prompt 生效）
    if not is_new:
        session.caller_system_prompt = caller_system_prompt
    session.context.request_public_base_url = _request_public_base_url(http_request)

    workspace_root = session.context.workspace_root if session.context else None
    try:
        user_input, input_items, user_content = _extract_user_input_and_items(request, workspace_root=workspace_root)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=f"Attachment not found: {e}") from e
    if not user_input.strip() and not input_items:
        raise HTTPException(status_code=400, detail="No user message found in messages")

    pending_schedule_response = await _maybe_handle_pending_schedule_confirmation(
        manager=manager,
        session=session,
        request=request,
        user_input=user_input,
        user_content=user_content,
        model=resolved_model,
    )
    if pending_schedule_response is not None:
        return pending_schedule_response

    agent_manager = get_external_agent_manager()
    schedule_creation_response = await _maybe_handle_schedule_creation_request(
        manager=manager,
        session=session,
        request=request,
        user_input=user_input,
        user_content=user_content,
        model=resolved_model,
        effort=resolved_effort,
        agent_manager=agent_manager,
        config=config,
    )
    if schedule_creation_response is not None:
        return schedule_creation_response

    connector_auth_event = await maybe_handle_connector_chat_auth(
        session=session,
        user_input=user_input,
        request_base_url=session.context.request_public_base_url if session.context else None,
    )
    if connector_auth_event is not None:
        resume_user_input = _connector_auth_resume_user_input(connector_auth_event)
        if resume_user_input and connector_auth_event.get("type") == "connector_auth_updated":
            merged_system_prompt = _merge_system_prompt(workspace_root, session.caller_system_prompt)
            return await _resume_after_connector_auth_chat_response(
                manager=manager,
                session=session,
                request=request,
                auth_user_input=user_input,
                auth_user_content=user_content,
                resume_user_input=resume_user_input,
                model=resolved_model,
                effort=resolved_effort,
                summary=request.summary,
                output_schema=request.output_schema,
                system_prompt=merged_system_prompt,
                agent_manager=agent_manager,
                config=config,
                event=connector_auth_event,
            )
        return await _connector_auth_chat_response(
            manager=manager,
            session=session,
            request=request,
            user_input=user_input,
            user_content=user_content,
            model=resolved_model,
            event=connector_auth_event,
        )

    attachment_items = [item for item in input_items if item.get("type") == "attachment"]
    codex_input_items = [item for item in input_items if item.get("type") != "attachment"]
    merged_system_prompt = _merge_system_prompt(workspace_root, session.caller_system_prompt)
    if request.stream:
        return StreamingResponse(
            stream_codex_chat_as_sse(
                session=session,
                user_input=user_input,
                input_items=codex_input_items,
                user_content=user_content,
                attachment_items=attachment_items,
                model=resolved_model,
                effort=resolved_effort,
                summary=request.summary,
                output_schema=request.output_schema,
                system_prompt=merged_system_prompt,
                manager=manager,
                agent_manager=agent_manager,
                config=config,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )
    return await collect_codex_chat_response(
        session=session,
        user_input=user_input,
        input_items=codex_input_items,
        user_content=user_content,
        attachment_items=attachment_items,
        model=resolved_model,
        effort=resolved_effort,
        summary=request.summary,
        output_schema=request.output_schema,
        system_prompt=merged_system_prompt,
        manager=manager,
        agent_manager=agent_manager,
        config=config,
    )


# ─── Deprecated Tasks API ───


def _raise_tasks_api_gone() -> None:
    raise HTTPException(status_code=410, detail="/v1/tasks has been removed. Use /v1/sessions instead.")


@router.api_route("/v1/tasks", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def deprecated_tasks_root(
    _user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    _raise_tasks_api_gone()


@router.api_route("/v1/tasks/{task_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def deprecated_tasks_path(
    task_path: str,
    _user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    _ = task_path
    _raise_tasks_api_gone()


# ─── Sessions ───


@router.get("/v1/sessions")
async def list_sessions(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session_infos = [_session_info_from_record(record) for record in manager.list_all_sessions(user_id=user_id)]
    return SessionListResponse(sessions=session_infos, count=len(session_infos))


@router.post("/v1/sessions")
async def create_session(
    request: CreateSessionRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if manager.sandbox_manager:
        manager.sandbox_manager.ensure_sandbox(user_id)
        assert_can_create_session(manager.sandbox_manager.config, user_id)
    session = manager.create_session(
        user_id=user_id,
        model=request.model,
        max_turns=request.max_turns,
        caller_system_prompt=request.system_prompt,
        feishu=request.feishu,
    )
    set_current_session_id(session.session_id)
    return _session_info_from_session(session)


@router.get("/v1/sessions/suspended")
async def list_suspended_sessions(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """列出所有已挂起的 session（仅当前 user）"""
    manager = get_session_manager()
    suspended = manager.list_suspended_sessions(user_id=user_id)

    sessions_out = []
    for s in suspended:
        entry = dict(s)
        if "model" in entry:
            entry["model"] = _display_model(entry["model"])
        sessions_out.append(SuspendedSessionInfo(**entry))

    return {
        "sessions": sessions_out,
        "count": len(suspended),
    }


@router.get("/v1/sessions/{session_id}")
async def get_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session = manager.get_session(session_id, user_id=user_id)
    if not session:
        session = manager.resume_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return _session_detail_from_session(session)


@router.post("/v1/sessions/{session_id}/stop")
async def stop_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """停止当前 session 正在进行的聊天/任务"""
    manager = get_session_manager()
    session = _get_or_resume_session(manager, session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    stopped = manager.stop_session(session_id, user_id=user_id)
    return {"ok": True, "stopped": stopped}


@router.post("/v1/sessions/{session_id}/connector-auth/poll")
async def poll_session_connector_auth(
    session_id: str,
    request: ConnectorAuthPollRequest,
    http_request: Request,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    config = get_config()
    if manager.sandbox_manager:
        manager.sandbox_manager.ensure_sandbox(user_id)
        assert_can_create_run(manager.sandbox_manager.config, user_id, _codex_chat_max_runtime_seconds(config))

    session = _get_or_resume_session(manager, session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    pending = session.pending_connector_auth
    if not isinstance(pending, dict):
        raise HTTPException(status_code=409, detail="No pending connector auth")
    if pending.get("connector") not in {"feishu", "google_workspace"}:
        raise HTTPException(status_code=409, detail="Pending connector auth cannot be polled")

    set_current_session_id(session.session_id)
    resolved_model = manager.configure_session_model(session, request.model)
    resolved_effort = request.effort
    if resolved_effort is None and session.context is not None:
        resolved_effort = session.context.options.reasoning_effort
    if session.context is not None:
        session.context.request_public_base_url = _request_public_base_url(http_request)

    previous_pending = dict(pending)
    connector_auth_event = await poll_pending_connector_chat_auth(
        session=session,
        request_base_url=session.context.request_public_base_url if session.context else None,
    )
    if connector_auth_event is None:
        raise HTTPException(status_code=409, detail="Pending connector auth cannot be polled")

    chat_request = _chat_request_from_connector_auth_poll(session_id, request)
    resume_user_input = _connector_auth_resume_user_input(connector_auth_event)
    workspace_root = session.context.workspace_root if session.context else None
    agent_manager = get_external_agent_manager()
    if resume_user_input and connector_auth_event.get("type") == "connector_auth_updated":
        merged_system_prompt = _merge_system_prompt(workspace_root, session.caller_system_prompt)
        return await _resume_after_connector_auth_chat_response(
            manager=manager,
            session=session,
            request=chat_request,
            auth_user_input="",
            auth_user_content=[],
            resume_user_input=resume_user_input,
            model=resolved_model,
            effort=resolved_effort,
            summary=request.summary,
            output_schema=request.output_schema,
            system_prompt=merged_system_prompt,
            agent_manager=agent_manager,
            config=config,
            event=connector_auth_event,
            persist_user_message=False,
        )

    if _connector_auth_poll_should_persist_message(connector_auth_event, previous_pending):
        return await _connector_auth_chat_response(
            manager=manager,
            session=session,
            request=chat_request,
            user_input="",
            user_content=[],
            model=resolved_model,
            event=connector_auth_event,
            persist_user_message=False,
        )

    return await _connector_auth_event_response(
        manager=manager,
        session=session,
        request=chat_request,
        model=resolved_model,
        event=connector_auth_event,
    )


@router.post("/v1/sessions/{session_id}/permissions/resolve")
async def resolve_permission_request(
    session_id: str,
    request: PermissionResolveRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """处理挂起的权限请求。"""
    manager = get_session_manager()
    session = manager.get_session(session_id, user_id=user_id)
    if not session:
        session = manager.resume_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return await _resolve_session_permission(manager, session, request)


@router.get("/v1/sessions/{session_id}/usage")
async def get_session_usage(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """获取 session 的累计 token 使用量"""
    manager = get_session_manager()
    session = manager.get_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "session_id": session.session_id,
        "total_input_tokens": session.total_input_tokens,
        "total_output_tokens": session.total_output_tokens,
        "total_tokens": session.total_input_tokens + session.total_output_tokens,
        "last_input_tokens": session.last_input_tokens,
        "message_count": len(session.messages),
    }


@router.delete("/v1/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.delete_session(session_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.post("/v1/sessions/{session_id}/context/clear")
async def clear_session_context(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session = manager.get_session(session_id, user_id=user_id)
    if not session:
        session = manager.resume_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    await _clear_session_context(manager, session)
    return {"ok": True, "session_id": session_id, "message_count": len(session.messages)}


# ─── Session Suspend / Resume ───


@router.post("/v1/sessions/{session_id}/suspend")
async def suspend_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """挂起 session：保存状态到磁盘，释放内存"""
    manager = get_session_manager()
    ok = manager.suspend_session(session_id, user_id=user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Session not found or already suspended")
    return {"ok": True, "session_id": session_id}


@router.post("/v1/sessions/{session_id}/resume")
async def resume_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """恢复已挂起的 session"""
    manager = get_session_manager()
    session = manager.resume_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Suspended session not found")
    return _session_info_from_session(session)


# ─── Sandboxes (user-scoped) ───


@router.post("/v1/sandboxes")
async def create_sandbox(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """幂等地为当前 user 创建 sandbox。已存在则直接返回当前摘要。"""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(user_id)
    summary = manager.sandbox_manager.sandbox_summary(user_id)
    if summary is None:
        raise HTTPException(status_code=500, detail="sandbox creation failed")
    return SandboxInfo(**summary)


@router.get("/v1/sandboxes")
async def get_sandbox(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """获取当前 user sandbox 摘要；不存在返回 404。"""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    summary = manager.sandbox_manager.sandbox_summary(user_id)
    if summary is None:
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    return SandboxInfo(**summary)


@router.delete("/v1/sandboxes")
async def delete_sandbox(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """销毁当前 user 的整个 sandbox（含所有 session）。`default` user 禁止销毁。"""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    for uid, sid in [k for k in list(manager._sessions.keys()) if k[0] == user_id]:
        manager.delete_session(sid, user_id=uid)

    await get_external_agent_manager().stop_user(user_id)

    try:
        ok = manager.sandbox_manager.teardown_sandbox(user_id, allow_default=False)
    except PermissionError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    return {"ok": True, "user_id": user_id}


# ─── External Agent Runs (Codex execution plane) ───


def _agent_run_info(job) -> AgentRunInfo:
    pending_approval = get_external_agent_manager().get_pending_approval(job.job_id)
    return AgentRunInfo(
        job_id=job.job_id,
        provider=job.provider,
        status=job.status.value,
        output_file=str(job.output_file) if job.output_file else None,
        events_file=str(job.events_file) if job.events_file else None,
        created_at=job.created_at.isoformat(),
        updated_at=job.updated_at.isoformat(),
        exit_code=job.exit_code,
        prompt_preview=job.prompt[:240],
        sandbox_cwd=(job.metadata or {}).get("sandbox_cwd"),
        stdout_tail=job.stdout_tail,
        stderr_tail=job.stderr_tail,
        error=job.error,
        pending_approval=pending_approval,
    )


def _agent_runs_dir(user_id: str):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    return manager.sandbox_manager.config.sandbox_dir(user_id) / "agent-runs"


def _agent_run_info_from_record(record: dict[str, Any]) -> AgentRunInfo:
    return AgentRunInfo(
        job_id=str(record.get("job_id") or ""),
        provider=str(record.get("provider") or ""),
        status=str(record.get("status") or ""),
        output_file=record.get("output_file") if isinstance(record.get("output_file"), str) else None,
        events_file=record.get("events_file") if isinstance(record.get("events_file"), str) else None,
        created_at=record.get("created_at") if isinstance(record.get("created_at"), str) else None,
        updated_at=record.get("updated_at") if isinstance(record.get("updated_at"), str) else None,
        exit_code=record.get("exit_code") if isinstance(record.get("exit_code"), int) else None,
        prompt_preview=record.get("prompt_preview") if isinstance(record.get("prompt_preview"), str) else None,
        sandbox_cwd=record.get("sandbox_cwd") if isinstance(record.get("sandbox_cwd"), str) else None,
        stdout_tail=record.get("stdout_tail") if isinstance(record.get("stdout_tail"), str) else "",
        stderr_tail=record.get("stderr_tail") if isinstance(record.get("stderr_tail"), str) else "",
        error=record.get("error") if isinstance(record.get("error"), str) else None,
    )


def _get_user_agent_job_or_404(job_id: str, user_id: str):
    job = get_external_agent_manager().get(job_id)
    if job is None or job.user_id != user_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return job


def _get_user_agent_record_or_404(job_id: str, user_id: str) -> AgentRunInfo:
    job = get_external_agent_manager().get(job_id)
    if job is not None and job.user_id == user_id:
        return _agent_run_info(job)
    record = find_user_job_record(_agent_runs_dir(user_id), job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return _agent_run_info_from_record(record)


def _get_live_user_agent_job_or_conflict(job_id: str, user_id: str):
    job = get_external_agent_manager().get(job_id)
    if job is not None and job.user_id == user_id:
        return job
    if find_user_job_record(_agent_runs_dir(user_id), job_id) is not None:
        raise HTTPException(status_code=409, detail="Agent run is not active")
    raise HTTPException(status_code=404, detail="Agent run not found")


def _get_user_agent_event_source_or_404(job_id: str, user_id: str) -> tuple[Path, Any]:
    job = get_external_agent_manager().get(job_id)
    if job is not None and job.user_id == user_id and job.events_file is not None:
        return job.events_file, lambda: job.status
    record = find_user_job_record(_agent_runs_dir(user_id), job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    events_file = record.get("events_file")
    if not isinstance(events_file, str):
        raise HTTPException(status_code=404, detail="Agent run events not found")
    status = str(record.get("status") or AgentRunnerStatus.COMPLETED.value)
    return Path(events_file), lambda: status


@router.post("/v1/runs")
async def create_agent_run(
    request: AgentRunCreateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    """Start a Codex-backed execution job in the current user's sandbox."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    workspace_root = manager.sandbox_manager.ensure_sandbox(user_id)
    assert_can_create_run(manager.sandbox_manager.config, user_id, request.max_runtime_seconds)
    runtime_dir = manager.sandbox_manager.config.sandbox_dir(user_id) / "agent-runs"
    turn_model, turn_effort = _resolve_agent_run_turn_config(request)

    try:
        job = start_agent_run(
            prompt=request.prompt,
            input_items=request.input_items,
            model=turn_model,
            effort=turn_effort,
            summary=request.summary,
            output_schema=request.output_schema,
            provider_name=request.provider,
            raw_cwd=request.cwd,
            max_runtime_seconds=request.max_runtime_seconds,
            user_id=user_id,
            session_id=None,
            workspace_root=workspace_root,
            runtime_dir=runtime_dir,
            manager=get_external_agent_manager(),
            sandbox_config=manager.sandbox_manager.config,
            require_agent_route=False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _agent_run_info(job)


# ─── Schedules (control-plane triggers for Codex runs) ───


def _schedule_sandbox_config(user_id: str):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(user_id)
    return manager.sandbox_manager.config


def _schedule_info_from_record(record: dict[str, Any]) -> ScheduleInfo:
    return ScheduleInfo(**record)


@router.get("/v1/schedules")
async def list_user_schedules(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduleListResponse:
    config = _schedule_sandbox_config(user_id)
    schedules = [_schedule_info_from_record(record) for record in list_schedules(config, user_id)]
    return ScheduleListResponse(schedules=schedules, count=len(schedules))


@router.post("/v1/schedules")
async def create_user_schedule(
    request: ScheduleCreateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduleInfo:
    config = _schedule_sandbox_config(user_id)
    try:
        record = create_schedule(config, user_id, request.model_dump(by_alias=False))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _schedule_info_from_record(record)


@router.get("/v1/schedules/{schedule_id}/runs")
async def list_user_schedule_runs(
    schedule_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduleRunListResponse:
    config = _schedule_sandbox_config(user_id)
    if get_schedule(config, user_id, schedule_id) is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    runs = [_agent_run_info_from_record(record) for record in list_schedule_run_records(config, user_id, schedule_id)]
    return ScheduleRunListResponse(runs=runs, count=len(runs))


@router.get("/v1/schedules/{schedule_id}")
async def get_user_schedule(
    schedule_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduleInfo:
    config = _schedule_sandbox_config(user_id)
    record = get_schedule(config, user_id, schedule_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _schedule_info_from_record(record)


@router.patch("/v1/schedules/{schedule_id}")
async def update_user_schedule(
    schedule_id: str,
    request: ScheduleUpdateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduleInfo:
    config = _schedule_sandbox_config(user_id)
    try:
        record = update_schedule(
            config,
            user_id,
            schedule_id,
            request.model_dump(exclude_unset=True, by_alias=False),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if record is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _schedule_info_from_record(record)


@router.delete("/v1/schedules/{schedule_id}")
async def delete_user_schedule(
    schedule_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    config = _schedule_sandbox_config(user_id)
    if not delete_schedule(config, user_id, schedule_id):
        raise HTTPException(status_code=404, detail="Schedule not found")
    return {"ok": True, "schedule_id": schedule_id}


@router.post("/v1/schedules/{schedule_id}/run-now")
async def run_user_schedule_now(
    schedule_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(user_id)
    try:
        job = trigger_schedule_now(
            config=manager.sandbox_manager.config,
            sandbox_manager=manager.sandbox_manager,
            agent_manager=get_external_agent_manager(),
            user_id=user_id,
            schedule_id=schedule_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if job is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _agent_run_info(job)


# ─── Internal Users / Quota ───


@router.get("/v1/users/me")
async def get_current_user_profile(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> UserProfileResponse:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(user_id)
    record = ensure_user_record(manager.sandbox_manager.config, user_id)
    return UserProfileResponse(**record)


@router.get("/v1/users/me/quota")
async def get_current_user_quota(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> UserQuotaStatusResponse:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(user_id)
    return UserQuotaStatusResponse(**quota_status(manager.sandbox_manager.config, user_id))


@router.put("/v1/users/{target_user_id}/quota")
async def update_user_quota_route(
    target_user_id: str,
    request: UserQuotaUpdateRequest,
    _user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> UserQuotaStatusResponse:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(target_user_id)
    update_user_quota(
        manager.sandbox_manager.config,
        target_user_id,
        request.model_dump(exclude_none=True),
    )
    return UserQuotaStatusResponse(**quota_status(manager.sandbox_manager.config, target_user_id))


# ─── Documents ───


def _workspace_root_or_404(user_id: str) -> Path:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    return workspace_root


@router.get("/v1/documents")
async def list_document_metadata(
    q: str | None = Query(default=None),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> DocumentListResponse:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    docs = [DocumentInfo(**doc) for doc in list_documents(manager.sandbox_manager.config, user_id, q)]
    return DocumentListResponse(documents=docs, count=len(docs))


@router.post("/v1/documents")
async def create_document_metadata(
    request: DocumentCreateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> DocumentInfo:
    workspace_root = _workspace_root_or_404(user_id)
    manager = get_session_manager()
    try:
        target = validate_path(request.path, workspace_root)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Path not found")
    doc = create_document(
        manager.sandbox_manager.config,
        user_id,
        title=request.title,
        path=request.path,
        linked_session_id=request.linked_session_id,
        summary=request.summary,
    )
    return DocumentInfo(**doc)


@router.get("/v1/documents/{document_id}")
async def get_document_metadata(
    document_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> DocumentInfo:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    doc = get_document(manager.sandbox_manager.config, user_id, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentInfo(**doc)


@router.patch("/v1/documents/{document_id}")
async def update_document_metadata(
    document_id: str,
    request: DocumentUpdateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> DocumentInfo:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    doc = update_document(
        manager.sandbox_manager.config,
        user_id,
        document_id,
        request.model_dump(exclude_unset=True),
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentInfo(**doc)


@router.delete("/v1/documents/{document_id}")
async def delete_document_metadata(
    document_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    if not delete_document(manager.sandbox_manager.config, user_id, document_id):
        raise HTTPException(status_code=404, detail="Document not found")
    return {"ok": True, "document_id": document_id}


@router.get("/v1/runs")
async def list_agent_runs(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunListResponse:
    records = list_user_job_records(_agent_runs_dir(user_id))
    live_jobs = {job.job_id: job for job in get_external_agent_manager().jobs.values() if job.user_id == user_id}
    merged: dict[str, AgentRunInfo] = {
        str(record.get("job_id")): _agent_run_info_from_record(record) for record in records if record.get("job_id")
    }
    for job_id, job in live_jobs.items():
        merged[job_id] = _agent_run_info(job)
    runs = sorted(
        merged.values(),
        key=lambda run: run.updated_at or run.created_at or "",
        reverse=True,
    )
    return AgentRunListResponse(runs=runs, count=len(runs))


@router.get("/v1/runs/{job_id}/events")
async def stream_agent_run_events(
    job_id: str,
    from_start: bool = Query(default=True),
    follow: bool = Query(default=True),
    heartbeat_seconds: int = Query(default=8, ge=1, le=60),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    events_file, get_status = _get_user_agent_event_source_or_404(job_id, user_id)
    return StreamingResponse(
        stream_run_events(
            events_file=events_file,
            get_status=get_status,
            from_start=from_start,
            follow=follow,
            heartbeat_seconds=heartbeat_seconds,
        ),
        media_type="text/event-stream",
    )


@router.get("/v1/runs/{job_id}")
async def get_agent_run(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    return _get_user_agent_record_or_404(job_id, user_id)


@router.post("/v1/runs/{job_id}/steer")
async def steer_agent_run(
    job_id: str,
    request: AgentRunSteerRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    _get_live_user_agent_job_or_conflict(job_id, user_id)
    get_external_agent_manager().steer(job_id, request.prompt)
    return _agent_run_info(_get_live_user_agent_job_or_conflict(job_id, user_id))


@router.post("/v1/runs/{job_id}/cancel")
async def cancel_agent_run(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    _get_live_user_agent_job_or_conflict(job_id, user_id)
    agent_manager = get_external_agent_manager()
    if agent_manager.cancel(job_id):
        await agent_manager.wait(job_id)
    return _agent_run_info(_get_live_user_agent_job_or_conflict(job_id, user_id))


# ─── Connectors ───


@router.get("/v1/connectors")
async def get_connectors(
    _api_key: str = Depends(verify_api_key),
) -> ConnectorListResponse:
    return ConnectorListResponse(
        connectors=[
            ConnectorInfo(
                name=connector.info.name,
                display_name=connector.info.display_name,
                description=connector.info.description,
                auth_type=connector.info.auth_type,
                kind=connector.info.kind,
                auth_flow=connector.info.auth_flow,
                auth_surfaces=connector.info.auth_surfaces,
                auth_start_path=connector.info.auth_start_path,
                auth_complete_path=connector.info.auth_complete_path,
                disconnect_path=connector.info.disconnect_path,
                accounts_path=connector.info.accounts_path,
            )
            for connector in list_connectors()
        ]
    )


def _connector_or_404(connector_name: str):
    connector = get_registered_connector(connector_name)
    if connector is None:
        raise HTTPException(status_code=404, detail=f"Connector {connector_name!r} not found")
    return connector


def _connector_action_response(result: ConnectorActionResult) -> ConnectorActionResponse:
    return ConnectorActionResponse(
        name=result.name,
        ok=result.ok,
        stage=result.stage,
        detail=result.detail,
        data=result.data,
    )


def _sandbox_manager_or_500():
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    return manager.sandbox_manager


def _ensure_connector_web_action_allowed(connector: Any, action: str) -> None:
    if connector.info.auth_surfaces.get("web"):
        return
    raise HTTPException(
        status_code=405,
        detail=f"Connector {connector.info.name!r} {action} is only available through chat.",
    )


@router.get("/v1/connectors/{connector_name}/status")
async def get_connector_status(
    connector_name: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ConnectorStatusResponse:
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    if manager.sandbox_manager.sandbox_summary(user_id) is None:
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")

    connector = _connector_or_404(connector_name)
    status = connector.status(manager.sandbox_manager.config, user_id)
    if status.connected:
        await _clear_connector_auth_if_connected(
            manager=manager,
            config=manager.sandbox_manager.config,
            connector=connector,
            user_id=user_id,
        )
    return ConnectorStatusResponse(
        name=status.name,
        connected=status.connected,
        required=status.required,
        detail=status.detail,
        metadata=status.metadata,
    )


@router.post("/v1/connectors/{connector_name}/auth/start")
async def start_connector_auth(
    connector_name: str,
    http_request: Request,
    payload: dict[str, Any] | None = Body(default=None),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ConnectorActionResponse:
    sandbox_manager = _sandbox_manager_or_500()
    sandbox_manager.ensure_sandbox(user_id)
    connector = _connector_or_404(connector_name)
    _ensure_connector_web_action_allowed(connector, "auth_start")
    try:
        async with sandbox_manager.user_lock(user_id):
            result = await connector.auth_start(
                sandbox_manager.config,
                user_id,
                payload or {},
                request_base_url=_request_public_base_url(http_request),
            )
    except ConnectorUnsupportedError as exc:
        raise HTTPException(status_code=405, detail=str(exc)) from exc
    await _clear_connector_auth_if_connected(
        manager=get_session_manager(),
        config=sandbox_manager.config,
        connector=connector,
        user_id=user_id,
        result=result,
    )
    return _connector_action_response(result)


@router.post("/v1/connectors/{connector_name}/auth/complete")
async def complete_connector_auth(
    connector_name: str,
    payload: dict[str, Any] | None = Body(default=None),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ConnectorActionResponse:
    sandbox_manager = _sandbox_manager_or_500()
    sandbox_manager.ensure_sandbox(user_id)
    connector = _connector_or_404(connector_name)
    _ensure_connector_web_action_allowed(connector, "auth_complete")
    try:
        async with sandbox_manager.user_lock(user_id):
            result = await connector.auth_complete(sandbox_manager.config, user_id, payload or {})
    except ConnectorUnsupportedError as exc:
        raise HTTPException(status_code=405, detail=str(exc)) from exc
    await _clear_connector_auth_if_connected(
        manager=get_session_manager(),
        config=sandbox_manager.config,
        connector=connector,
        user_id=user_id,
        result=result,
    )
    return _connector_action_response(result)


@router.post("/v1/connectors/{connector_name}/disconnect")
async def disconnect_connector(
    connector_name: str,
    payload: dict[str, Any] | None = Body(default=None),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ConnectorActionResponse:
    sandbox_manager = _sandbox_manager_or_500()
    sandbox_manager.ensure_sandbox(user_id)
    connector = _connector_or_404(connector_name)
    _ensure_connector_web_action_allowed(connector, "disconnect")
    try:
        async with sandbox_manager.user_lock(user_id):
            result = await connector.disconnect(sandbox_manager.config, user_id, payload or {})
    except ConnectorUnsupportedError as exc:
        raise HTTPException(status_code=405, detail=str(exc)) from exc
    return _connector_action_response(result)


@router.get("/v1/connectors/{connector_name}/accounts")
async def get_connector_accounts(
    connector_name: str,
    check: bool = False,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    sandbox_manager = _sandbox_manager_or_500()
    if sandbox_manager.sandbox_summary(user_id) is None:
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    connector = _connector_or_404(connector_name)
    accounts = getattr(connector, "accounts", None)
    if accounts is None:
        raise HTTPException(status_code=405, detail=f"Connector {connector_name!r} does not support accounts")
    return await accounts(sandbox_manager.config, user_id, check=check)


@router.post("/v1/workspace/attachments", response_model=WorkspaceAttachmentResponse)
async def upload_workspace_attachment(
    file: UploadFile = File(...),
    kind: Annotated[str, Form()] = "attachment",
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Save an uploaded image or attachment in the current user's workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    if kind not in {"image", "attachment"}:
        raise HTTPException(status_code=400, detail="kind must be image or attachment")

    workspace_root = manager.sandbox_manager.ensure_sandbox(user_id)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        attachment = save_uploaded_attachment(
            config=manager.sandbox_manager.config,
            user_id=user_id,
            workspace_root=workspace_root,
            filename=file.filename,
            content_type=file.content_type,
            data=data,
            kind=kind,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    return attachment.to_response()


@router.post("/v1/workspace/upload", response_model=WorkspaceUploadResponse)
async def upload_workspace_files(
    files: list[UploadFile] = File(...),
    path: Annotated[str, Form()] = "/workspace",
    overwrite: Annotated[bool, Form()] = False,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Save uploaded files directly into one workspace directory."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    workspace_root = manager.sandbox_manager.ensure_sandbox(user_id)
    uploads = [WorkspaceUploadItem(filename=file.filename, data=await file.read()) for file in files]

    def assert_uploads_within_quota(targets: list[tuple[Path, int]]) -> None:
        status = quota_status(manager.sandbox_manager.config, user_id)
        max_bytes = int(status["quota"]["max_workspace_mb"]) * 1024 * 1024
        current_size = int(status["usage"]["workspace_size_bytes"])
        final_sizes = dict(targets)
        replaced_size = sum(target.stat().st_size for target in final_sizes if target.exists() and target.is_file())
        projected_size = current_size - replaced_size + sum(final_sizes.values())
        if projected_size > max_bytes:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "quota_exceeded",
                    "resource": "workspace_bytes",
                    "limit": max_bytes,
                    "used": projected_size,
                },
            )

    try:
        entries = save_workspace_uploaded_files(
            workspace_root,
            path,
            uploads,
            overwrite=overwrite,
            before_write=assert_uploads_within_quota,
        )
    except WorkspaceUploadConflictError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": "workspace_upload_conflict", "conflicts": e.conflicts},
        ) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except NotADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a directory") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return WorkspaceUploadResponse(entries=entries)


@router.get("/v1/workspace/download")
async def download_workspace_file(
    path: str = Query(...),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Download one file from the current user's sandbox workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")

    try:
        target = validate_path(path, workspace_root)
        if not target.exists():
            raise FileNotFoundError(path)
        if not target.is_file():
            raise IsADirectoryError(path)
        return FileResponse(
            target,
            media_type=detect_mime_type(target.name),
            filename=target.name,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except IsADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a file") from e


@router.get("/v1/workspace")
async def list_workspace(
    path: str = Query(default="/workspace"),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """List one directory in the current user's sandbox workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.ensure_sandbox(user_id)

    try:
        return browse_workspace_directory(workspace_root, path)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except NotADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a directory") from e


@router.get("/v1/workspace/search", response_model=WorkspaceSearchResponse)
async def search_workspace(
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    scope: str = Query(default="name"),
    kind: str = Query(default="all"),
    file_type: str = Query(default="all"),
    include_hidden: bool = Query(default=False),
    max_file_bytes: int = Query(default=1024 * 1024, ge=1, le=5 * 1024 * 1024),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Search the current user's sandbox workspace by name/path or file content."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.ensure_sandbox(user_id)

    try:
        return search_workspace_files(
            workspace_root,
            q,
            limit=limit,
            scope=scope,
            kind=kind,
            file_type=file_type,
            include_hidden=include_hidden,
            max_file_bytes=max_file_bytes,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e


@router.post("/v1/workspace/rename", response_model=WorkspaceEntry)
async def rename_workspace(
    request: WorkspaceRenameRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Rename one file or directory in the current user's sandbox workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.ensure_sandbox(user_id)

    try:
        return rename_workspace_entry(workspace_root, request.path, new_name=request.name)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail="A file or folder with that name already exists") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/v1/workspace/file")
async def get_workspace_file(
    path: str = Query(...),
    limit: int = Query(default=64 * 1024, ge=1, le=256 * 1024),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Preview one text file in the current user's sandbox workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")

    try:
        return preview_workspace_file(workspace_root, path, limit_bytes=limit)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except IsADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a file") from e
    except BinaryFileError as e:
        raise HTTPException(status_code=415, detail="Binary files cannot be previewed") from e


@router.put("/v1/workspace/file")
async def save_workspace_file(
    request: WorkspaceFileSaveRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Save one UTF-8 text file in the current user's sandbox workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")

    try:
        target = validate_path(request.path, workspace_root)
        assert_workspace_save_within_quota(
            manager.sandbox_manager.config,
            user_id,
            target,
            len(request.content.encode("utf-8")),
        )
        return save_workspace_text_file(
            workspace_root,
            request.path,
            content=request.content,
            expected_modified_at=request.expected_modified_at,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except IsADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a file") from e
    except WorkspaceFileConflictError as e:
        raise HTTPException(status_code=409, detail="File changed on disk") from e
    except WorkspaceFileTooLargeError as e:
        raise HTTPException(status_code=413, detail="File is too large to save from the web editor") from e
    except BinaryFileError as e:
        raise HTTPException(status_code=415, detail="Binary files cannot be edited") from e


@router.get("/v1/sandboxes/gogcli-accounts")
async def get_gogcli_accounts(
    check: bool = False,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> GogcliAccountsResponse:
    """列出当前 user 已绑的 Google 账号；兼容旧 sandbox 路径，实际委托 connector。"""
    sandbox_manager = _sandbox_manager_or_500()
    connector = _connector_or_404("google_workspace")
    accounts_fn = getattr(connector, "accounts")
    data = await accounts_fn(sandbox_manager.config, user_id, check=check)
    accounts = [GogcliAccountInfo(**a) for a in data.get("accounts", [])]
    return GogcliAccountsResponse(
        has_client_config=bool(data.get("has_client_config")),
        accounts=accounts,
        count=len(accounts),
        checked=check,
    )


def _gogcli_oauth_html(title: str, body: str, *, status_code: int = 200) -> HTMLResponse:
    escaped_title = html.escape(title)
    escaped_body = html.escape(body)
    return HTMLResponse(
        status_code=status_code,
        content=f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escaped_title}</title>
    <style>
      body {{
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.6;
        max-width: 720px;
        margin: 12vh auto;
        padding: 0 24px;
        color: #111827;
      }}
      h1 {{ font-size: 24px; margin-bottom: 12px; }}
      p {{ color: #374151; }}
    </style>
  </head>
  <body>
    <h1>{escaped_title}</h1>
    <p>{escaped_body}</p>
  </body>
</html>""",
    )


@router.get("/v1/sandboxes/gogcli/oauth/callback", include_in_schema=False)
async def gogcli_oauth_callback(request: Request) -> HTMLResponse:
    """Browser callback for assisted gogcli OAuth.

    Google cannot send Ripple API auth headers during OAuth redirects. This
    endpoint is therefore protected by Ripple's random `state`; the route only
    works when the Google Workspace connector has registered a matching pending
    state in this process.
    """
    from ripple.sandbox.gogcli_oauth import build_gogcli_callback_auth_url, pop_pending_gogcli_oauth  # noqa: PLC0415

    state = (request.query_params.get("state") or "").strip()
    if not state:
        return _gogcli_oauth_html("Google 授权失败", "OAuth 回调缺少 state 参数。", status_code=400)

    pending = pop_pending_gogcli_oauth(state)
    if pending is None:
        return _gogcli_oauth_html(
            "Google 授权已过期",
            "找不到匹配的 OAuth 登录请求，可能已经超过 10 分钟或服务已重启。请回到 Ripple 重新发起授权。",
            status_code=400,
        )

    provider_error = request.query_params.get("error")
    if provider_error:
        description = request.query_params.get("error_description") or provider_error
        return _gogcli_oauth_html(
            "Google 授权被拒绝",
            f"Google 返回错误：{description}。请回到 Ripple 重新发起授权。",
            status_code=400,
        )

    if "code" not in request.query_params:
        return _gogcli_oauth_html("Google 授权失败", "OAuth 回调缺少 code 参数。", status_code=400)

    try:
        sandbox_config = _sandbox_manager_or_500().config
    except HTTPException:
        return _gogcli_oauth_html("Google 授权失败", "Ripple sandbox 未启用，无法保存 gogcli 凭证。", status_code=500)

    query_string = request.scope.get("query_string", b"")
    if isinstance(query_string, bytes):
        query = query_string.decode("ascii", errors="ignore")
    else:
        query = str(query_string)
    callback_url = build_gogcli_callback_auth_url(pending.redirect_uri, query)
    result = await complete_google_workspace_oauth_callback(sandbox_config, pending, callback_url)
    if not result.ok:
        logger.warning(
            "user {} assisted gog oauth completion failed (stage={}): {}",
            pending.user_id,
            result.stage,
            result.detail[:300],
        )
        return _gogcli_oauth_html(
            "Google 授权未完成",
            f"{result.detail} 请回到 Ripple 重新发起授权。",
            status_code=500,
        )

    connector = _connector_or_404("google_workspace")
    await _clear_connector_auth_if_connected(
        manager=get_session_manager(),
        config=sandbox_config,
        connector=connector,
        user_id=pending.user_id,
    )
    email = result.data.get("email") if isinstance(result.data, dict) else ""
    logger.info("user {} assisted gogcli 绑定成功: {}", pending.user_id, email)
    return _gogcli_oauth_html(
        "Google 授权完成",
        "Ripple 已保存 Google Workspace 授权。可以关闭这个页面，回到对话继续。",
    )


# ─── Bilibili 扫码二维码图片 ───


@router.get("/v1/bilibili/qrcode.png")
async def bilibili_qrcode_png(
    content: str = Query(..., min_length=1, max_length=2048, description="QR 要编码的原始内容"),
):
    """渲染 B 站扫码登录二维码为 PNG，无鉴权（只做图像编码，无状态）。

    设计理由：
      * LLM 对话里直接嵌 base64 PNG 会爆 token，所以让工具返回短 URL、前端/用户
        在浏览器打开这个路由拿到真正的图像。
      * 路由无状态：`content` 参数就是要 encode 的字符串（通常是 B 站 qrcode
        scan-web URL），服务端用 `segno` 即时渲染。不做任何日志/审计——content
        本身只含 `qrcode_key`（B 站公开，没 SESSDATA，泄露也无意义）。
      * 不鉴权：防止前端/用户打开时还要带 token；PNG 内容对谁都是同样的，安全上
        没区别。rate-limit 由上游 nginx/API gateway 负责（如果需要）。
    """
    from ripple.sandbox.bilibili import render_qrcode_png_bytes

    try:
        png = render_qrcode_png_bytes(content)
    except Exception as e:  # noqa: BLE001 — 编码失败返 400 即可
        raise HTTPException(status_code=400, detail=f"QR 编码失败: {e}") from e
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=60"},
    )


# ─── Sandbox Info ───


@router.get("/v1/sandbox/info")
async def get_sandbox_info(
    _api_key: str = Depends(verify_api_key),
):
    """获取沙箱系统信息"""
    manager = get_session_manager()
    sandbox = manager.sandbox_manager

    if not sandbox:
        return {"enabled": False}

    return {
        "enabled": True,
        "mode": "nsjail",
        "sandboxes_root": str(sandbox.config.sandboxes_root),
        "caches_root": str(sandbox.config.caches_root),
        "resource_limits": {
            "max_memory_mb": sandbox.config.resource_limits.max_memory_mb,
            "max_cpu_ms_per_sec": sandbox.config.resource_limits.max_cpu_ms_per_sec,
            "max_file_size_mb": sandbox.config.resource_limits.max_file_size_mb,
            "max_pids": sandbox.config.resource_limits.max_pids,
            "command_timeout": sandbox.config.resource_limits.command_timeout,
        },
        "runtimes": {
            "python": {
                "available": sandbox.config.uv_bin_dir is not None,
                "uv_bin_dir": sandbox.config.uv_bin_dir,
            },
            "nodejs": {
                "available": sandbox.config.node_dir is not None,
                "node_dir": sandbox.config.node_dir,
                "pnpm_store_dir": str(sandbox.config.pnpm_cache_dir),
            },
        },
        "idle_suspend_seconds": sandbox.config.idle_suspend_seconds,
        "retention_seconds": sandbox.config.retention_seconds,
        "active_sessions": len(manager.list_sessions()),
        "suspended_sessions": len(manager.list_suspended_sessions()),
    }
