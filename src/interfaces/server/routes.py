"""API 路由定义

包含 chat completions、models、health、sessions、tools/invoke 等端点。
"""

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse

from interfaces.server.auth import verify_api_key
from interfaces.server.deps import get_user_id
from interfaces.server.schemas import (
    ChatCompletionRequest,
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
from interfaces.server.sessions import SessionManager
from interfaces.server.sse import collect_query_response, stream_query_as_sse
from ripple.messages.utils import serialize_messages
from ripple.scheduler.manager import ScheduledJobRunningError, SchedulerManager, compute_initial_next_run
from ripple.scheduler.models import ScheduledJob, utc_now
from ripple.tools.orchestration import execute_tool, find_tool_by_name
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger, session_context, set_current_session_id

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

    前端下拉菜单用的是 "sonnet"/"opus"/"haiku" 这类 alias，
    但 session.model 存的是 resolve 后的 raw ID（如 "claude-sonnet-4-6"
    或 "anthropic/claude-sonnet-4.6"）。直接透传给前端会导致下拉框选中状态丢失。

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
        default_model=config.get("model.default", "sonnet"),
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


@router.post("/v1/chat/completions")
async def chat_completions(
    request: ChatCompletionRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    config = get_config()

    resolved_model = config.resolve_model(request.model)
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

    # 对已存在的 session：本轮带了 system 就覆盖，没带就清空 caller 段（仅默认 prompt 生效）
    if not is_new:
        session.caller_system_prompt = caller_system_prompt

    if request.stream:
        return StreamingResponse(
            _stream_chat(
                session,
                user_input,
                resolved_model,
                max_turns,
                request.thinking,
                manager,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )
    else:
        return await _non_stream_chat(
            session,
            user_input,
            resolved_model,
            max_turns,
            request.thinking,
            manager,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )


async def _stream_chat(
    session,
    user_input: str,
    model: str,
    max_turns: int,
    thinking: bool | None = None,
    manager: SessionManager | None = None,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
):
    """流式聊天：返回 SSE 事件生成器"""
    import asyncio
    import json as _json

    from interfaces.server.sessions import _merge_system_prompt

    with session_context(session.session_id):
        try:
            async with session.lock:
                session.current_task = asyncio.current_task()
                session.status = "running"
                if manager:
                    manager.touch_session(session)
                session.pending_question = None
                session.pending_options = None
                session.pending_permission_request = None
                if session.context and session.context.abort_signal:
                    from ripple.core.context import AbortSignal

                    session.context.abort_signal = AbortSignal()
                # 每轮动态合并：默认 prompt（刷新日期和 skill 列表） + caller 段
                workspace_root = session.context.workspace_root if session.context else None
                merged_system_prompt = _merge_system_prompt(workspace_root, session.caller_system_prompt)
                try:
                    async for sse_line in stream_query_as_sse(
                        user_input=user_input,
                        context=session.context,
                        client=session.client,
                        model=model,
                        max_turns=max_turns,
                        history_messages=session.messages,
                        model_history_messages=session.model_messages,
                        system_prompt=merged_system_prompt,
                        thinking=thinking,
                        context_manager=session.context_manager,
                        temperature=temperature,
                        max_tokens=max_tokens,
                    ):
                        if sse_line.startswith("data: ") and sse_line.strip() not in ("data: [DONE]",):
                            try:
                                payload = _json.loads(sse_line[6:].strip())
                                usage = payload.get("usage", {})
                                if usage:
                                    session.total_input_tokens += usage.get("prompt_tokens", 0)
                                    session.total_output_tokens += usage.get("completion_tokens", 0)
                                    session.last_input_tokens = usage.get("prompt_tokens", 0)
                                event_type = payload.get("type")
                                if event_type == "agent_stop":
                                    stop_reason = payload.get("stop_reason", "")
                                    metadata = payload.get("metadata", {})
                                    if stop_reason == "ask_user":
                                        session.status = "awaiting_user_input"
                                        session.pending_question = metadata.get("question")
                                        options = metadata.get("options")
                                        session.pending_options = options if isinstance(options, list) else None
                                    elif stop_reason == "permission_request":
                                        session.status = "awaiting_permission"
                                        session.pending_question = metadata.get("question")
                                        session.pending_permission_request = (
                                            metadata if isinstance(metadata, dict) and metadata else None
                                        )
                            except (_json.JSONDecodeError, AttributeError):
                                pass
                        yield sse_line
                finally:
                    session.current_task = None
                    if session.status == "running":
                        session.status = "idle"
                    if manager:
                        manager.touch_session(session)
                        manager.persist_session(session)
        except asyncio.CancelledError:
            logger.info("流式聊天被取消: {}", session.session_id)
            session.status = "idle"
            import json

            yield f"data: {json.dumps({'error': {'message': 'Request cancelled', 'type': 'cancelled'}})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.exception("流式聊天异常: {}", e)
            import json

            error_data = {"error": {"message": str(e), "type": "server_error"}}
            yield f"data: {json.dumps(error_data)}\n\n"
            yield "data: [DONE]\n\n"


async def _non_stream_chat(
    session,
    user_input: str,
    model: str,
    max_turns: int,
    thinking: bool | None = None,
    manager: SessionManager | None = None,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """非流式聊天：收集完整响应"""
    import asyncio

    from interfaces.server.sessions import _merge_system_prompt

    with session_context(session.session_id):
        try:
            async with session.lock:
                session.current_task = asyncio.current_task()
                session.status = "running"
                if manager:
                    manager.touch_session(session)
                session.pending_question = None
                session.pending_options = None
                session.pending_permission_request = None
                if session.context and session.context.abort_signal:
                    from ripple.core.context import AbortSignal

                    session.context.abort_signal = AbortSignal()
                workspace_root = session.context.workspace_root if session.context else None
                merged_system_prompt = _merge_system_prompt(workspace_root, session.caller_system_prompt)
                try:
                    result = await collect_query_response(
                        user_input=user_input,
                        context=session.context,
                        client=session.client,
                        model=model,
                        max_turns=max_turns,
                        history_messages=session.messages,
                        model_history_messages=session.model_messages,
                        system_prompt=merged_system_prompt,
                        thinking=thinking,
                        context_manager=session.context_manager,
                        temperature=temperature,
                        max_tokens=max_tokens,
                    )
                    usage = result.get("usage", {})
                    if usage:
                        session.total_input_tokens += usage.get("prompt_tokens", 0)
                        session.total_output_tokens += usage.get("completion_tokens", 0)
                        session.last_input_tokens = usage.get("prompt_tokens", 0)
                    finish_reason = result.get("choices", [{}])[0].get("finish_reason", "stop")
                    stop_metadata = result.get("stop_metadata", {})
                    if finish_reason == "ask_user":
                        session.status = "awaiting_user_input"
                        session.pending_question = stop_metadata.get("question")
                        options = stop_metadata.get("options")
                        session.pending_options = options if isinstance(options, list) else None
                    elif finish_reason == "permission_request":
                        session.status = "awaiting_permission"
                        session.pending_permission_request = stop_metadata if isinstance(stop_metadata, dict) else None
                    result["session_id"] = session.session_id
                    return result
                finally:
                    session.current_task = None
                    if session.status == "running":
                        session.status = "idle"
                    if manager:
                        manager.touch_session(session)
                        manager.persist_session(session)
        except asyncio.CancelledError:
            logger.info("非流式聊天被取消: {}", session.session_id)
            session.status = "idle"
            raise HTTPException(status_code=499, detail="Request cancelled")
        except Exception as e:
            logger.exception("非流式聊天异常: {}", e)
            raise HTTPException(status_code=500, detail=str(e))


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

    try:
        ok = manager.sandbox_manager.teardown_sandbox(user_id, allow_default=False)
    except PermissionError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    return {"ok": True, "user_id": user_id}


@router.get("/v1/sandboxes/gogcli-accounts")
async def get_gogcli_accounts(
    check: bool = False,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> GogcliAccountsResponse:
    """列出当前 user 已绑的 Google 账号（共享 GoogleWorkspaceAuthStatus 工具的解析逻辑）。"""
    from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN  # noqa: PLC0415
    from ripple.sandbox.executor import execute_in_sandbox  # noqa: PLC0415
    from ripple.sandbox.gogcli import parse_auth_list_output  # noqa: PLC0415
    from ripple.tools.builtin.bash import _sandbox_config  # noqa: PLC0415

    if _sandbox_config is None or not _sandbox_config.gogcli_cli_install_root:
        return GogcliAccountsResponse()

    has_client = _sandbox_config.has_gogcli_client_config(user_id)
    cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
    if check:
        cmd += " --check"

    stdout, _stderr, code = await execute_in_sandbox(cmd, _sandbox_config, user_id, timeout=30 if check else 10)
    if code != 0:
        return GogcliAccountsResponse(has_client_config=has_client, checked=check)

    try:
        raw = parse_auth_list_output(stdout)
    except ValueError:
        return GogcliAccountsResponse(has_client_config=has_client, checked=check)

    accounts = [GogcliAccountInfo(**a) for a in raw]
    return GogcliAccountsResponse(
        has_client_config=has_client,
        accounts=accounts,
        count=len(accounts),
        checked=check,
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
