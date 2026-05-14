"""API 路由定义

包含 chat completions、models、health、sessions、tools/invoke 等端点。
"""

import html
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response, StreamingResponse

from interfaces.server.auth import verify_api_key
from interfaces.server.codex_chat import collect_codex_chat_response, stream_codex_chat_as_sse
from interfaces.server.deps import get_user_id
from interfaces.server.schemas import (
    AgentRunCreateRequest,
    AgentRunInfo,
    AgentRunSteerRequest,
    ChatCompletionRequest,
    ConnectorActionResponse,
    ConnectorInfo,
    ConnectorListResponse,
    ConnectorStatusResponse,
    CreateSessionRequest,
    GogcliAccountInfo,
    GogcliAccountsResponse,
    ModelInfo,
    ModelsResponse,
    PermissionResolveRequest,
    SandboxInfo,
    ScheduleCreateRequest,
    ScheduledJobInfo,
    ScheduledJobListResponse,
    ScheduledRunInfo,
    ScheduledRunListResponse,
    ScheduleUpdateRequest,
    SessionDetailResponse,
    SessionInfo,
    SessionListResponse,
    SuspendedSessionInfo,
    SystemInfoResponse,
    ToolInvokeRequest,
    ToolInvokeResponse,
)
from interfaces.server.sessions import SessionManager, _merge_system_prompt
from interfaces.server.workspace_browser import (
    BinaryFileError,
    browse_workspace_directory,
    preview_workspace_file,
)
from ripple.agent_runners.manager import get_external_agent_manager
from ripple.agent_runners.service import start_agent_run
from ripple.connectors.base import ConnectorActionResult, ConnectorUnsupportedError
from ripple.connectors.registry import get_connector as get_registered_connector
from ripple.connectors.registry import list_connectors
from ripple.messages.utils import serialize_messages
from ripple.scheduler.manager import ScheduledJobRunningError, SchedulerManager, compute_initial_next_run
from ripple.scheduler.models import ScheduledJob, utc_now
from ripple.tools.orchestration import execute_tool, find_tool_by_name
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger, set_current_session_id

logger = get_logger("server.routes")

router = APIRouter()

_session_manager: SessionManager | None = None
_scheduler_manager: SchedulerManager | None = None


def get_session_manager() -> SessionManager:
    if _session_manager is None:
        raise RuntimeError("SessionManager not initialized")
    return _session_manager


def set_session_manager(manager: SessionManager):
    global _session_manager
    _session_manager = manager


def get_scheduler_manager() -> SchedulerManager:
    if _scheduler_manager is None:
        raise RuntimeError("SchedulerManager not initialized")
    return _scheduler_manager


def set_scheduler_manager(manager: SchedulerManager):
    global _scheduler_manager
    _scheduler_manager = manager


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
    """从 OpenAI 格式的 messages 中提取最后一条用户消息的文本"""
    for msg in reversed(request.messages):
        if msg.role == "user":
            if isinstance(msg.content, str):
                return msg.content
            if isinstance(msg.content, list):
                texts = [b.get("text", "") for b in msg.content if isinstance(b, dict) and b.get("type") == "text"]
                return "\n".join(texts)
    return ""


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


def _find_parent_assistant_message(messages: list[Any], tool_use_id: str, source_uuid: str | None = None):
    for msg in reversed(messages):
        if getattr(msg, "type", None) != "assistant":
            continue
        if source_uuid and getattr(msg, "uuid", None) == source_uuid:
            return msg
        for block in msg.message.get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") == tool_use_id:
                return msg
    return None


def _replace_tool_result(messages: list[Any], tool_use_id: str, replacement_messages: list[Any]) -> None:
    """用实际执行结果替换权限等待占位 tool_result。"""
    if not replacement_messages:
        return

    for idx, msg in enumerate(messages):
        if getattr(msg, "type", None) != "user":
            continue
        content = msg.message.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            if block.get("tool_use_id") != tool_use_id:
                continue
            if "Awaiting user permission" not in str(block.get("content", "")):
                continue
            messages[idx] = replacement_messages[0]
            if len(replacement_messages) > 1:
                messages[idx + 1 : idx + 1] = replacement_messages[1:]
            return

    messages.extend(replacement_messages)


def _request_public_base_url(request: Request) -> str | None:
    from ripple.sandbox.gogcli_oauth import gogcli_oauth_request_base_url  # noqa: PLC0415

    return gogcli_oauth_request_base_url(dict(request.headers), str(request.url))


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
    user_input = _extract_user_input(request)
    caller_system_prompt = _extract_caller_system_prompt(request)

    if not user_input:
        raise HTTPException(status_code=400, detail="No user message found in messages")

    session, is_new = manager.get_or_create_session(
        session_id=request.session_id,
        user_id=user_id,
        model=request.model,
        max_turns=max_turns,
        caller_system_prompt=caller_system_prompt,
    )
    set_current_session_id(session.session_id)
    resolved_model = manager.configure_session_model(session, request.model)

    # 对已存在的 session：本轮带了 system 就覆盖，没带就清空 caller 段（仅默认 prompt 生效）
    if not is_new:
        session.caller_system_prompt = caller_system_prompt
    session.context.request_public_base_url = _request_public_base_url(http_request)

    workspace_root = session.context.workspace_root if session.context else None
    merged_system_prompt = _merge_system_prompt(workspace_root, session.caller_system_prompt)
    agent_manager = get_external_agent_manager()
    if request.stream:
        return StreamingResponse(
            stream_codex_chat_as_sse(
                session=session,
                user_input=user_input,
                model=resolved_model,
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
        model=resolved_model,
        system_prompt=merged_system_prompt,
        manager=manager,
        agent_manager=agent_manager,
        config=config,
    )


# ─── Sessions ───


@router.get("/v1/sessions")
async def list_sessions(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    all_sessions = manager.list_all_sessions(user_id=user_id)

    session_infos = [
        SessionInfo(
            session_id=s["session_id"],
            title=s.get("title", ""),
            model=_display_model(s.get("model", "")),
            created_at=s.get("created_at", ""),
            last_active=s.get("last_active", ""),
            message_count=s.get("message_count", 0),
            status=s.get("status", "active"),
        )
        for s in all_sessions
    ]
    return SessionListResponse(sessions=session_infos, count=len(session_infos))


@router.post("/v1/sessions")
async def create_session(
    request: CreateSessionRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session = manager.create_session(
        user_id=user_id,
        model=request.model,
        max_turns=request.max_turns,
        caller_system_prompt=request.system_prompt,
        feishu=request.feishu,
    )
    set_current_session_id(session.session_id)
    return SessionInfo(
        session_id=session.session_id,
        model=_display_model(session.model),
        created_at=session.created_at.isoformat(),
        last_active=session.last_active.isoformat(),
        message_count=len(session.messages),
    )


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

    return SessionDetailResponse(
        session_id=session.session_id,
        model=_display_model(session.model),
        created_at=session.created_at.isoformat(),
        last_active=session.last_active.isoformat(),
        message_count=len(session.messages),
        messages=serialize_messages(session.messages),
        status=session.status,
        pending_question=session.pending_question,
        pending_options=session.pending_options,
        pending_permission_request=session.pending_permission_request,
    )


@router.post("/v1/sessions/{session_id}/stop")
async def stop_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """停止当前 session 正在进行的聊天/任务"""
    manager = get_session_manager()
    session = manager.get_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    stopped = manager.stop_session(session_id, user_id=user_id)
    return {"ok": True, "stopped": stopped}


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

    permission_request = session.pending_permission_request
    if not permission_request:
        raise HTTPException(status_code=409, detail="No pending permission request")

    async with session.lock:
        permission_manager = session.context.permission_manager if session.context else None
        if not permission_manager:
            raise HTTPException(status_code=500, detail="Permission manager unavailable")

        tool_name = permission_request.get("tool", "")
        tool_use_id = permission_request.get("tool_use_id") or ""
        source_uuid = permission_request.get("source_assistant_uuid")
        params = permission_request.get("params", {})
        params = params if isinstance(params, dict) else {}

        if not isinstance(tool_name, str) or not tool_name:
            raise HTTPException(status_code=400, detail="Invalid permission request")
        if not isinstance(tool_use_id, str) or not tool_use_id:
            raise HTTPException(status_code=400, detail="Permission request is missing tool_use_id")

        tool = find_tool_by_name(session.context.options.tools, tool_name)
        if not tool:
            raise HTTPException(status_code=404, detail="Requested tool not found")

        replay_messages: list[Any] = []
        if request.action in ("allow", "always"):
            permission_manager.grant_permission(
                tool,
                params,
                scope="once" if request.action == "allow" else "session",
            )
            parent_message = _find_parent_assistant_message(session.messages, tool_use_id, source_uuid)
            async for update in execute_tool(
                {"id": tool_use_id, "name": tool_name, "input": params},
                parent_message,
                session.context,
            ):
                if update.message:
                    replay_messages.append(update.message)
                if update.new_context:
                    session.context = update.new_context
        else:
            from ripple.messages.utils import create_tool_result_message

            replay_messages.append(
                create_tool_result_message(
                    tool_use_id=tool_use_id,
                    content="Permission denied by user. Do not retry this tool call unless the user explicitly asks.",
                    is_error=True,
                    tool_name=tool_name,
                    source_assistant_uuid=source_uuid if isinstance(source_uuid, str) else None,
                )
            )

        _replace_tool_result(session.messages, tool_use_id, replay_messages)
        if session.model_messages:
            _replace_tool_result(session.model_messages, tool_use_id, replay_messages)
        else:
            session.model_messages = list(session.messages)

        session.pending_permission_request = None
        session.pending_question = None
        session.pending_options = None
        session.status = "idle"
        manager.touch_session(session)
        manager.persist_session(session)

    return {"ok": True, "action": request.action, "replayed": request.action in ("allow", "always")}


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
    return SessionInfo(
        session_id=session.session_id,
        model=_display_model(session.model),
        created_at=session.created_at.isoformat(),
        last_active=session.last_active.isoformat(),
        message_count=len(session.messages),
        status="active",
    )


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
    return AgentRunInfo(
        job_id=job.job_id,
        provider=job.provider,
        status=job.status.value,
        output_file=str(job.output_file) if job.output_file else None,
        events_file=str(job.events_file) if job.events_file else None,
        stdout_tail=job.stdout_tail,
        stderr_tail=job.stderr_tail,
        error=job.error,
    )


def _get_user_agent_job_or_404(job_id: str, user_id: str):
    job = get_external_agent_manager().get(job_id)
    if job is None or job.user_id != user_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return job


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
    runtime_dir = manager.sandbox_manager.config.sandbox_dir(user_id) / "agent-runs"

    try:
        job = start_agent_run(
            prompt=request.prompt,
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


@router.get("/v1/runs/{job_id}")
async def get_agent_run(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    return _agent_run_info(_get_user_agent_job_or_404(job_id, user_id))


@router.post("/v1/runs/{job_id}/steer")
async def steer_agent_run(
    job_id: str,
    request: AgentRunSteerRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    _get_user_agent_job_or_404(job_id, user_id)
    get_external_agent_manager().steer(job_id, request.prompt)
    return _agent_run_info(_get_user_agent_job_or_404(job_id, user_id))


@router.post("/v1/runs/{job_id}/cancel")
async def cancel_agent_run(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> AgentRunInfo:
    _get_user_agent_job_or_404(job_id, user_id)
    agent_manager = get_external_agent_manager()
    if agent_manager.cancel(job_id):
        await agent_manager.wait(job_id)
    return _agent_run_info(_get_user_agent_job_or_404(job_id, user_id))


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
    try:
        async with sandbox_manager.user_lock(user_id):
            result = await connector.auth_complete(sandbox_manager.config, user_id, payload or {})
    except ConnectorUnsupportedError as exc:
        raise HTTPException(status_code=405, detail=str(exc)) from exc
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

    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")

    try:
        return browse_workspace_directory(workspace_root, path)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except NotADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a directory") from e


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
    endpoint is therefore protected by gogcli's random `state`; the route only
    works when `GoogleWorkspaceLoginStart` has registered a matching pending
    state in this process.
    """
    from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN  # noqa: PLC0415
    from ripple.sandbox.executor import execute_in_sandbox  # noqa: PLC0415
    from ripple.sandbox.gogcli import GOGCLI_BASIC_SERVICES_ARG, ensure_gogcli_keyring_password  # noqa: PLC0415
    from ripple.sandbox.gogcli_oauth import build_gogcli_callback_auth_url, pop_pending_gogcli_oauth  # noqa: PLC0415
    from ripple.sandbox.nsjail_config import write_nsjail_config  # noqa: PLC0415
    from ripple.tools.builtin.bash import _sandbox_config  # noqa: PLC0415
    from ripple.tools.builtin.gogcli_login_complete import _shq  # noqa: PLC0415

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

    if _sandbox_config is None:
        return _gogcli_oauth_html("Google 授权失败", "Ripple sandbox 未启用，无法保存 gogcli 凭证。", status_code=500)
    if not _sandbox_config.gogcli_cli_install_root:
        return _gogcli_oauth_html("Google 授权失败", "gogcli 未预装，无法保存 Google 凭证。", status_code=500)

    ensure_gogcli_keyring_password(_sandbox_config, pending.user_id)
    write_nsjail_config(_sandbox_config, pending.user_id)
    query_string = request.scope.get("query_string", b"")
    if isinstance(query_string, bytes):
        query = query_string.decode("ascii", errors="ignore")
    else:
        query = str(query_string)
    callback_url = build_gogcli_callback_auth_url(pending.redirect_uri, query)
    cmd = (
        f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(pending.email)} "
        f"--services {GOGCLI_BASIC_SERVICES_ARG} --remote --step 2 --auth-url {_shq(callback_url)}"
    )
    stdout, stderr, code = await execute_in_sandbox(cmd, _sandbox_config, pending.user_id, timeout=60)
    if code != 0:
        detail = (stderr or stdout)[-500:] or "unknown error"
        logger.warning(
            "user {} assisted gog auth step 2 失败 (code={}): {}",
            pending.user_id,
            code,
            detail[:300],
        )
        return _gogcli_oauth_html(
            "Google 授权未完成",
            f"gogcli 保存凭证失败：{detail}。请回到 Ripple 重新发起授权。",
            status_code=500,
        )

    logger.info("user {} assisted gogcli 绑定成功: {}", pending.user_id, pending.email)
    return _gogcli_oauth_html(
        "Google 授权完成",
        "Ripple 已保存 Google Workspace 授权。可以关闭这个页面，回到对话继续。",
    )


# ─── Scheduled Sandbox Jobs (user-scoped) ───


def _job_info(job: ScheduledJob) -> ScheduledJobInfo:
    return ScheduledJobInfo(**job.model_dump())


def _run_info(run) -> ScheduledRunInfo:
    return ScheduledRunInfo(**run.model_dump())


def _validate_schedule_fields(
    schedule_type: str,
    *,
    run_at,
    interval_seconds: int | None,
    execution_type: str = "command",
    command: str | None = None,
    prompt: str | None = None,
) -> None:
    if schedule_type == "once" and run_at is None:
        raise HTTPException(status_code=400, detail="run_at is required for once schedules")
    if schedule_type == "interval" and interval_seconds is None:
        raise HTTPException(status_code=400, detail="interval_seconds is required for interval schedules")
    if execution_type == "command" and not (command or "").strip():
        raise HTTPException(status_code=400, detail="command is required for command schedules")
    if execution_type == "agent" and not (prompt or "").strip():
        raise HTTPException(status_code=400, detail="prompt is required for agent schedules")


@router.post("/v1/sandbox/schedules")
async def create_schedule(
    request: ScheduleCreateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledJobInfo:
    """Create a user-scoped scheduled sandbox command."""
    _validate_schedule_fields(
        request.schedule_type,
        run_at=request.run_at,
        interval_seconds=request.interval_seconds,
        execution_type=request.execution_type,
        command=request.command,
        prompt=request.prompt,
    )
    scheduler = get_scheduler_manager()
    job = ScheduledJob(
        user_id=user_id,
        name=request.name,
        command=request.command or "",
        prompt=request.prompt,
        execution_type=request.execution_type,
        created_from=request.created_from,
        schedule_type=request.schedule_type,
        run_at=request.run_at,
        interval_seconds=request.interval_seconds,
        max_runs=request.max_runs,
        enabled=request.enabled,
        timeout_seconds=request.timeout_seconds,
    )
    created = scheduler.create_job(job)
    return _job_info(created)


@router.get("/v1/sandbox/schedules")
async def list_schedules(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledJobListResponse:
    scheduler = get_scheduler_manager()
    jobs = [_job_info(job) for job in scheduler.list_jobs(user_id)]
    return ScheduledJobListResponse(jobs=jobs, count=len(jobs))


@router.get("/v1/sandbox/schedules/{job_id}")
async def get_schedule(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledJobInfo:
    scheduler = get_scheduler_manager()
    job = scheduler.get_job(user_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    return _job_info(job)


@router.patch("/v1/sandbox/schedules/{job_id}")
async def update_schedule(
    job_id: str,
    request: ScheduleUpdateRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledJobInfo:
    scheduler = get_scheduler_manager()
    job = scheduler.get_job(user_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Scheduled job not found")

    update = request.model_dump(exclude_unset=True)
    for key, value in update.items():
        setattr(job, key, value)
    _validate_schedule_fields(
        job.schedule_type,
        run_at=job.run_at,
        interval_seconds=job.interval_seconds,
        execution_type=job.execution_type,
        command=job.command,
        prompt=job.prompt,
    )
    job.next_run_at = compute_initial_next_run(job, now=utc_now())
    updated = scheduler.update_job(job)
    return _job_info(updated)


@router.delete("/v1/sandbox/schedules/{job_id}")
async def delete_schedule(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    scheduler = get_scheduler_manager()
    try:
        removed = scheduler.delete_job(user_id, job_id)
    except ScheduledJobRunningError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    return {"ok": True}


@router.post("/v1/sandbox/schedules/{job_id}/run")
async def run_schedule_now(
    job_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledRunInfo:
    scheduler = get_scheduler_manager()
    run = await scheduler.run_job(user_id, job_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Scheduled job not found or already running")
    return _run_info(run)


@router.get("/v1/sandbox/schedules/{job_id}/runs")
async def list_schedule_runs(
    job_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledRunListResponse:
    scheduler = get_scheduler_manager()
    if scheduler.get_job(user_id, job_id) is None:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    runs = [_run_info(run) for run in scheduler.list_runs(user_id, job_id, limit=limit)]
    return ScheduledRunListResponse(runs=runs, count=len(runs))


@router.get("/v1/sandbox/schedules/{job_id}/runs/{run_id}")
async def get_schedule_run(
    job_id: str,
    run_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> ScheduledRunInfo:
    scheduler = get_scheduler_manager()
    if scheduler.get_job(user_id, job_id) is None:
        raise HTTPException(status_code=404, detail="Scheduled job not found")
    run = scheduler.get_run(user_id, job_id, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Scheduled run not found")
    return _run_info(run)


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


# ─── Tools Invoke ───


@router.post("/v1/tools/invoke")
async def invoke_tool(
    request: ToolInvokeRequest,
    http_request: Request,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()

    if request.session_id:
        session = manager.get_session(request.session_id, user_id=user_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        session = manager.create_session(user_id=user_id)

    context = session.context
    context.request_public_base_url = _request_public_base_url(http_request)
    tool_instance = None
    for t in context.options.tools:
        if t.name == request.tool:
            tool_instance = t
            break

    if not tool_instance:
        available = [t.name for t in context.options.tools]
        raise HTTPException(
            status_code=404,
            detail=f"Tool '{request.tool}' not found. Available: {available}",
        )

    try:
        result = await tool_instance.call(args=request.args, context=context, parent_message=None)
        return ToolInvokeResponse(ok=True, result=str(result.data))
    except Exception as e:
        logger.exception("工具调用异常: {}", e)
        return ToolInvokeResponse(ok=False, error=str(e))
