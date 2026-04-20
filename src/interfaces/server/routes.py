"""API 路由定义

包含 chat completions、models、health、sessions、tools/invoke 等端点。
"""

import time
import traceback
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from interfaces.server.auth import verify_api_key
from interfaces.server.schemas import (
    ChatCompletionRequest,
    CreateSessionRequest,
    ModelInfo,
    ModelsResponse,
    PermissionResolveRequest,
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
from ripple.tools.orchestration import find_tool_by_name
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger, session_context

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


@router.post("/v1/chat/completions")
async def chat_completions(
    request: ChatCompletionRequest,
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
        model=request.model,
        max_turns=max_turns,
        caller_system_prompt=caller_system_prompt,
    )

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
    thinking: bool = False,
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
                        system_prompt=merged_system_prompt,
                        thinking=thinking,
                        conversation_log=session.conversation_log,
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
                        manager.persist_session(session.session_id)
        except asyncio.CancelledError:
            logger.info("流式聊天被取消: {}", session.session_id)
            session.status = "idle"
            import json

            yield f"data: {json.dumps({'error': {'message': 'Request cancelled', 'type': 'cancelled'}})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("流式聊天异常: {}\n{}", e, traceback.format_exc())
            import json

            error_data = {"error": {"message": str(e), "type": "server_error"}}
            yield f"data: {json.dumps(error_data)}\n\n"
            yield "data: [DONE]\n\n"


async def _non_stream_chat(
    session,
    user_input: str,
    model: str,
    max_turns: int,
    thinking: bool = False,
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
                        system_prompt=merged_system_prompt,
                        thinking=thinking,
                        conversation_log=session.conversation_log,
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
                        manager.persist_session(session.session_id)
        except asyncio.CancelledError:
            logger.info("非流式聊天被取消: {}", session.session_id)
            session.status = "idle"
            raise HTTPException(status_code=499, detail="Request cancelled")
        except Exception as e:
            logger.error("非流式聊天异常: {}\n{}", e, traceback.format_exc())
            raise HTTPException(status_code=500, detail=str(e))


# ─── Sessions ───


@router.get("/v1/sessions")
async def list_sessions(
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    all_sessions = manager.list_all_sessions()

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
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session = manager.create_session(
        model=request.model,
        max_turns=request.max_turns,
        caller_system_prompt=request.system_prompt,
        feishu=request.feishu,
    )
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
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session = manager.get_session(session_id)
    if not session:
        session = manager.resume_session(session_id)
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
    _api_key: str = Depends(verify_api_key),
):
    """停止当前 session 正在进行的聊天/任务"""
    manager = get_session_manager()
    session = manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    stopped = manager.stop_session(session_id)
    return {"ok": True, "stopped": stopped}


@router.post("/v1/sessions/{session_id}/permissions/resolve")
async def resolve_permission_request(
    session_id: str,
    request: PermissionResolveRequest,
    _api_key: str = Depends(verify_api_key),
):
    """处理挂起的权限请求。"""
    manager = get_session_manager()
    session = manager.get_session(session_id)
    if not session:
        session = manager.resume_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    permission_request = session.pending_permission_request
    if not permission_request:
        raise HTTPException(status_code=409, detail="No pending permission request")

    permission_manager = session.context.permission_manager if session.context else None
    if not permission_manager:
        raise HTTPException(status_code=500, detail="Permission manager unavailable")

    if request.action in ("allow", "always"):
        tool = find_tool_by_name(session.context.options.tools, permission_request.get("tool", ""))
        if not tool:
            raise HTTPException(status_code=404, detail="Requested tool not found")
        params = permission_request.get("params", {})
        permission_manager.grant_permission(
            tool, params if isinstance(params, dict) else {}, scope="once" if request.action == "allow" else "session"
        )

    session.pending_permission_request = None
    session.pending_question = None
    session.pending_options = None
    session.status = "idle"
    manager.persist_session(session.session_id)

    return {"ok": True, "action": request.action}


@router.get("/v1/sessions/{session_id}/usage")
async def get_session_usage(
    session_id: str,
    _api_key: str = Depends(verify_api_key),
):
    """获取 session 的累计 token 使用量"""
    manager = get_session_manager()
    session = manager.get_session(session_id)
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
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


# ─── Session Suspend / Resume ───


@router.post("/v1/sessions/{session_id}/suspend")
async def suspend_session(
    session_id: str,
    _api_key: str = Depends(verify_api_key),
):
    """挂起 session：保存状态到磁盘，释放内存"""
    manager = get_session_manager()
    ok = manager.suspend_session(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Session not found or already suspended")
    return {"ok": True, "session_id": session_id}


@router.post("/v1/sessions/{session_id}/resume")
async def resume_session(
    session_id: str,
    _api_key: str = Depends(verify_api_key),
):
    """恢复已挂起的 session"""
    manager = get_session_manager()
    session = manager.resume_session(session_id)
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
    _api_key: str = Depends(verify_api_key),
):
    """列出所有已挂起的 session"""
    manager = get_session_manager()
    suspended = manager.list_suspended_sessions()

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
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()

    if request.session_id:
        session = manager.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        session = manager.create_session()

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
        logger.error("工具调用异常: {}\n{}", e, traceback.format_exc())
        return ToolInvokeResponse(ok=False, error=str(e))
