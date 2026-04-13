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
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

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
    from ripple.skills.loader import get_global_loader

    tool_names = get_server_tool_names()

    loader = get_global_loader()
    skills = [{"name": s.name, "description": s.description[:150]} for s in loader.list_skills()]

    presets = config.get_model_presets() or {}
    model_presets = {alias: info.get("model", alias) for alias, info in presets.items()}

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

    if not user_input:
        raise HTTPException(status_code=400, detail="No user message found in messages")

    session, is_new = manager.get_or_create_session(
        session_id=request.session_id,
        model=request.model,
        max_turns=max_turns,
    )

    if request.stream:
        return StreamingResponse(
            _stream_chat(session, user_input, resolved_model, max_turns, request.thinking, manager),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Ripple-Session-Id": session.session_id,
            },
        )
    else:
        return await _non_stream_chat(session, user_input, resolved_model, max_turns, request.thinking, manager)


async def _stream_chat(
    session, user_input: str, model: str, max_turns: int, thinking: bool = False, manager: SessionManager | None = None
):
    """流式聊天：返回 SSE 事件生成器"""
    import asyncio
    import json as _json

    try:
        async with session.lock:
            session.current_task = asyncio.current_task()
            session.status = "running"
            if session.context and session.context.abort_signal:
                from ripple.core.context import AbortSignal

                session.context.abort_signal = AbortSignal()
            try:
                async for sse_line in stream_query_as_sse(
                    user_input=user_input,
                    context=session.context,
                    client=session.client,
                    model=model,
                    max_turns=max_turns,
                    history_messages=session.messages,
                    system_prompt=session.system_prompt,
                    thinking=thinking,
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
                                if stop_reason == "ask_user":
                                    session.status = "awaiting_user_input"
                                    session.pending_question = payload.get("metadata", {}).get("question")
                                elif stop_reason == "permission_request":
                                    session.status = "awaiting_permission"
                        except (_json.JSONDecodeError, AttributeError):
                            pass
                    yield sse_line
            finally:
                session.current_task = None
                if session.status == "running":
                    session.status = "idle"
                session.trim_messages_if_needed()
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
) -> dict[str, Any]:
    """非流式聊天：收集完整响应"""
    import asyncio

    try:
        async with session.lock:
            session.current_task = asyncio.current_task()
            session.status = "running"
            if session.context and session.context.abort_signal:
                from ripple.core.context import AbortSignal

                session.context.abort_signal = AbortSignal()
            try:
                result = await collect_query_response(
                    user_input=user_input,
                    context=session.context,
                    client=session.client,
                    model=model,
                    max_turns=max_turns,
                    history_messages=session.messages,
                    system_prompt=session.system_prompt,
                    thinking=thinking,
                )
                usage = result.get("usage", {})
                if usage:
                    session.total_input_tokens += usage.get("prompt_tokens", 0)
                    session.total_output_tokens += usage.get("completion_tokens", 0)
                    session.last_input_tokens = usage.get("prompt_tokens", 0)
                return result
            finally:
                session.current_task = None
                if session.status == "running":
                    session.status = "idle"
                session.trim_messages_if_needed()
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
            model=s.get("model", ""),
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
        system_prompt=request.system_prompt,
    )
    return SessionInfo(
        session_id=session.session_id,
        model=session.model,
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

    from ripple.messages.utils import normalize_messages_for_api

    return SessionDetailResponse(
        session_id=session.session_id,
        model=session.model,
        created_at=session.created_at.isoformat(),
        last_active=session.last_active.isoformat(),
        message_count=len(session.messages),
        messages=normalize_messages_for_api(session.messages),
        status=session.status,
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
        model=session.model,
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
    return {
        "sessions": [SuspendedSessionInfo(**s) for s in suspended],
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
