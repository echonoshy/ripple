"""Codex-backed chat completion bridge.

Ripple owns user/session/sandbox control. Codex is the execution plane. This
module adapts a Codex agent run back into the OpenAI-compatible response shape
used by the existing API and web client.
"""

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from interfaces.server.sessions import Session, SessionManager, SessionStatus
from ripple.agent_runners.manager import ExternalAgentJob, ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerResult, AgentRunnerStatus
from ripple.agent_runners.service import start_agent_run
from ripple.connectors.registry import list_connectors
from ripple.messages.types import Message
from ripple.messages.utils import create_assistant_message, create_user_message
from ripple.skills.manifest import render_skill_manifest
from ripple.utils.config import Config
from ripple.utils.logger import get_logger, session_context

logger = get_logger("server.codex_chat")

_HEARTBEAT_SECONDS = 8.0


def _message_text(message: Message) -> str:
    if message.type == "user":
        content = message.message.get("content", [])
    elif message.type == "assistant":
        content = message.message.get("content", [])
    else:
        return ""

    parts: list[str] = []
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = block.get("text", "")
            if isinstance(text, str) and text.strip():
                parts.append(text)
        elif block.get("type") == "tool_result":
            text = block.get("content", "")
            if isinstance(text, str) and text.strip():
                parts.append(f"[tool_result] {text}")
    return "\n".join(parts).strip()


def _conversation_transcript(messages: list[Message], *, max_messages: int = 20) -> str:
    lines: list[str] = []
    for message in messages[-max_messages:]:
        if message.type not in {"user", "assistant"}:
            continue
        text = _message_text(message)
        if not text:
            continue
        role = "User" if message.type == "user" else "Assistant"
        lines.append(f"{role}: {text}")
    return "\n\n".join(lines)


def _connector_manifest(session: Session) -> str:
    context = session.context
    sandbox_manager = context.sandbox_manager if context else None
    if sandbox_manager is None:
        return "- sandbox: unavailable"

    rows: list[str] = []
    for connector in list_connectors():
        try:
            status = connector.status(sandbox_manager.config, session.user_id)
        except Exception as exc:  # noqa: BLE001
            rows.append(f"- {connector.info.name}: status_error ({exc})")
            continue
        connected = "connected" if status.connected else "not_connected"
        detail = f" - {status.detail}" if status.detail else ""
        rows.append(f"- {connector.info.name}: {connected}{detail}")
    return "\n".join(rows) if rows else "- no connectors registered"


def build_codex_chat_prompt(
    *,
    session: Session,
    user_input: str,
    system_prompt: str | None,
) -> str:
    """Build a single Codex turn prompt with Ripple control-plane context."""

    transcript = _conversation_transcript(session.messages)
    history_section = transcript if transcript else "(no previous turns in this Ripple session)"
    workspace_root = session.context.workspace_root if session.context else None
    return (
        "You are Codex, running as Ripple's trusted execution plane.\n"
        "Ripple is the control plane: it owns user identity, sandbox isolation, connector state, "
        "permissions, and API/session lifecycle. Do the real work inside the current user's workspace.\n\n"
        "## Ripple Session\n"
        f"- user_id: {session.user_id}\n"
        f"- session_id: {session.session_id}\n"
        "- workspace: current working directory\n\n"
        "## Connector Status\n"
        f"{_connector_manifest(session)}\n\n"
        "## Available Skills\n"
        f"{render_skill_manifest(workspace_root)}\n\n"
        "## System Instructions\n"
        f"{system_prompt or '(none)'}\n\n"
        "## Conversation So Far\n"
        f"{history_section}\n\n"
        "## Current User Request\n"
        f"{user_input.strip()}\n"
    )


def _chunk(chunk_id: str, model: str, created: int, delta: dict[str, Any], finish_reason: str | None = None) -> str:
    payload = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _usage(
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    last_prompt_tokens: int = 0,
    cached_input_tokens: int = 0,
    reasoning_output_tokens: int = 0,
    model_context_window: int | None = None,
) -> dict[str, int]:
    usage = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "last_prompt_tokens": last_prompt_tokens,
        "cached_input_tokens": cached_input_tokens,
        "reasoning_output_tokens": reasoning_output_tokens,
    }
    if model_context_window is not None:
        usage["model_context_window"] = model_context_window
    return usage


def _int_value(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _read_output(result: AgentRunnerResult | None) -> str:
    if result is None:
        return ""
    if result.output_file and result.output_file.exists():
        return result.output_file.read_text(encoding="utf-8")
    return result.stdout_tail or ""


def _append_session_messages(session: Session, user_input: str, assistant_text: str) -> None:
    user_created_at = datetime.now(timezone.utc).isoformat()
    session.messages.append(create_user_message(content=user_input, created_at=user_created_at))
    session.messages.append(create_assistant_message(content=[{"type": "text", "text": assistant_text}]))
    session.model_messages = list(session.messages)


def _require_workspace(session: Session) -> tuple[Path, Path, Any]:
    if session.context is None or session.context.workspace_root is None:
        raise RuntimeError("Codex chat requires a user sandbox workspace")
    runtime_dir = session.context.session_runtime_dir or session.context.workspace_root.parent / "agent-runs"
    return session.context.workspace_root, runtime_dir, session.context.sandbox_manager.config


def _max_runtime_seconds(config: Config) -> int:
    return int(
        config.get(
            "server.codex_chat.max_runtime_seconds",
            config.get("external_agents.codex.max_runtime_seconds", 3600),
        )
        or 3600
    )


def _start_chat_run(
    *,
    session: Session,
    prompt: str,
    config: Config,
    agent_manager: ExternalAgentManager,
) -> ExternalAgentJob:
    workspace_root, runtime_dir, sandbox_config = _require_workspace(session)
    return start_agent_run(
        prompt=prompt,
        provider_name="codex",
        raw_cwd="/workspace",
        max_runtime_seconds=_max_runtime_seconds(config),
        user_id=session.user_id,
        session_id=session.session_id,
        workspace_root=workspace_root,
        runtime_dir=runtime_dir,
        manager=agent_manager,
        sandbox_config=sandbox_config,
        require_agent_route=False,
    )


def _extract_event_delta(event: dict[str, Any]) -> str:
    if event.get("type") != "codex.notification":
        return ""
    message = (event.get("data") or {}).get("message")
    if not isinstance(message, dict):
        return ""
    params = message.get("params", {})
    if not isinstance(params, dict):
        return ""
    delta = params.get("delta")
    if isinstance(delta, str):
        return delta
    item = params.get("item")
    if isinstance(item, dict):
        text = item.get("text") or item.get("content")
        if isinstance(text, str):
            return text
    return ""


def _extract_usage_event(event: dict[str, Any]) -> dict[str, int] | None:
    if event.get("type") != "codex.notification":
        return None
    message = (event.get("data") or {}).get("message")
    if not isinstance(message, dict) or message.get("method") != "thread/tokenUsage/updated":
        return None
    params = message.get("params", {})
    if not isinstance(params, dict):
        return None
    token_usage = params.get("tokenUsage")
    if not isinstance(token_usage, dict):
        return None
    total = token_usage.get("total")
    last = token_usage.get("last")
    if not isinstance(total, dict) or not isinstance(last, dict):
        return None
    model_context_window = token_usage.get("modelContextWindow")
    return _usage(
        prompt_tokens=_int_value(last.get("inputTokens")),
        completion_tokens=_int_value(last.get("outputTokens")),
        total_tokens=_int_value(last.get("totalTokens")),
        last_prompt_tokens=_int_value(total.get("totalTokens")),
        cached_input_tokens=_int_value(last.get("cachedInputTokens")),
        reasoning_output_tokens=_int_value(last.get("reasoningOutputTokens")),
        model_context_window=_int_value(model_context_window) if model_context_window is not None else None,
    )


def _tool_name_for_codex_item(item: dict[str, Any]) -> str:
    item_type = item.get("type")
    if item_type == "commandExecution":
        return "command_execution"
    if item_type == "fileChange":
        return "file_change"
    if item_type == "mcpToolCall":
        server = item.get("server")
        tool = item.get("tool")
        if isinstance(server, str) and isinstance(tool, str):
            return f"{server}.{tool}"
        return "mcp_tool_call"
    if item_type == "dynamicToolCall":
        namespace = item.get("namespace")
        tool = item.get("tool")
        if isinstance(namespace, str) and namespace and isinstance(tool, str):
            return f"{namespace}.{tool}"
        return tool if isinstance(tool, str) and tool else "dynamic_tool_call"
    if item_type == "collabAgentToolCall":
        tool = item.get("tool")
        return f"agent.{tool}" if isinstance(tool, str) and tool else "agent_tool_call"
    if item_type == "webSearch":
        return "web_search"
    if item_type == "imageView":
        return "view_image"
    if item_type == "imageGeneration":
        return "image_generation"
    return str(item_type or "codex_item")


def _tool_arguments_for_codex_item(item: dict[str, Any]) -> dict[str, Any]:
    item_type = item.get("type")
    if item_type == "commandExecution":
        return {
            "command": item.get("command"),
            "cwd": item.get("cwd"),
            "source": item.get("source"),
        }
    if item_type == "mcpToolCall":
        return {
            "server": item.get("server"),
            "tool": item.get("tool"),
            "arguments": item.get("arguments") or {},
        }
    if item_type == "dynamicToolCall":
        return {
            "namespace": item.get("namespace"),
            "tool": item.get("tool"),
            "arguments": item.get("arguments") or {},
        }
    if item_type == "fileChange":
        return {"changes": item.get("changes") or []}
    if item_type == "webSearch":
        return {"query": item.get("query"), "action": item.get("action")}
    if item_type == "imageView":
        return {"path": item.get("path")}
    if item_type == "imageGeneration":
        return {"status": item.get("status"), "revised_prompt": item.get("revisedPrompt")}
    if item_type == "collabAgentToolCall":
        return {
            "tool": item.get("tool"),
            "prompt": item.get("prompt"),
            "model": item.get("model"),
            "receiver_thread_ids": item.get("receiverThreadIds") or [],
        }
    return dict(item)


def _tool_result_for_codex_item(item: dict[str, Any]) -> str | dict[str, Any]:
    item_type = item.get("type")
    if item_type == "commandExecution":
        return {
            "status": item.get("status"),
            "exit_code": item.get("exitCode"),
            "duration_ms": item.get("durationMs"),
            "output": item.get("aggregatedOutput") or "",
        }
    if item_type == "mcpToolCall":
        return {
            "status": item.get("status"),
            "result": item.get("result"),
            "error": item.get("error"),
            "duration_ms": item.get("durationMs"),
        }
    if item_type == "dynamicToolCall":
        return {
            "status": item.get("status"),
            "success": item.get("success"),
            "content_items": item.get("contentItems") or [],
            "duration_ms": item.get("durationMs"),
        }
    if item_type == "fileChange":
        return {"status": item.get("status"), "changes": item.get("changes") or []}
    if item_type == "webSearch":
        return {"query": item.get("query"), "action": item.get("action")}
    if item_type == "imageView":
        return {"path": item.get("path")}
    if item_type == "imageGeneration":
        return {
            "status": item.get("status"),
            "revised_prompt": item.get("revisedPrompt"),
            "saved_path": item.get("savedPath"),
        }
    if item_type == "collabAgentToolCall":
        return {
            "status": item.get("status"),
            "receiver_thread_ids": item.get("receiverThreadIds") or [],
            "agents_states": item.get("agentsStates") or {},
        }
    return dict(item)


def _extract_tool_event(event: dict[str, Any]) -> dict[str, Any] | None:
    if event.get("type") != "codex.notification":
        return None
    message = (event.get("data") or {}).get("message")
    if not isinstance(message, dict):
        return None
    method = message.get("method")
    params = message.get("params", {})
    if not isinstance(params, dict):
        return None
    item = params.get("item")
    if not isinstance(item, dict):
        return None
    item_id = item.get("id")
    if not isinstance(item_id, str) or not item_id:
        return None

    item_type = item.get("type")
    if item_type in {"userMessage", "agentMessage", "plan", "reasoning", "hookPrompt", "contextCompaction"}:
        return None

    if method == "item/started":
        return {
            "type": "tool_call",
            "id": item_id,
            "name": _tool_name_for_codex_item(item),
            "input": _tool_arguments_for_codex_item(item),
            "status": "running",
        }
    if method == "item/completed":
        return {
            "type": "tool_result",
            "tool_use_id": item_id,
            "content": _tool_result_for_codex_item(item),
        }
    return None


def _extract_approval(event: dict[str, Any]) -> dict[str, Any] | None:
    if event.get("type") != "codex.approval_request":
        return None
    data = event.get("data")
    data = data if isinstance(data, dict) else {}
    approval = data.get("approval")
    return approval if isinstance(approval, dict) else None


def _mark_session_awaiting_approval(session: Session, approval: dict[str, Any]) -> None:
    session.status = SessionStatus.AWAITING_PERMISSION
    session.pending_permission_request = approval
    session.pending_question = None
    session.pending_options = None


def _read_new_events(events_file: Path, offset: int) -> tuple[list[dict[str, Any]], int]:
    if not events_file.exists():
        return [], offset
    events: list[dict[str, Any]] = []
    with events_file.open("r", encoding="utf-8") as handle:
        handle.seek(offset)
        for line in handle:
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return events, handle.tell()


async def collect_codex_chat_response(
    *,
    session: Session,
    user_input: str,
    model: str,
    system_prompt: str | None,
    manager: SessionManager,
    agent_manager: ExternalAgentManager,
    config: Config,
) -> dict[str, Any]:
    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    with session_context(session.session_id):
        try:
            async with session.lock:
                session.current_task = asyncio.current_task()
                session.status = "running"
                session.pending_question = None
                session.pending_options = None
                session.pending_permission_request = None
                manager.touch_session(session)

                prompt = build_codex_chat_prompt(session=session, user_input=user_input, system_prompt=system_prompt)
                job = _start_chat_run(session=session, prompt=prompt, config=config, agent_manager=agent_manager)
                offset = 0
                usage = _usage()
                try:
                    while job.status == AgentRunnerStatus.RUNNING:
                        events, offset = _read_new_events(job.events_file, offset) if job.events_file else ([], offset)
                        for event in events:
                            usage_event = _extract_usage_event(event)
                            if usage_event is not None:
                                usage = usage_event
                                continue
                            approval = _extract_approval(event)
                            if approval is not None:
                                _mark_session_awaiting_approval(session, approval)
                                manager.touch_session(session)
                                manager.persist_session(session)
                                raise HTTPException(status_code=409, detail="Codex approval required")
                        await asyncio.sleep(0.05)
                    result = await agent_manager.wait(job.job_id)
                    if job.events_file:
                        events, offset = _read_new_events(job.events_file, offset)
                        for event in events:
                            usage_event = _extract_usage_event(event)
                            if usage_event is not None:
                                usage = usage_event
                                continue
                            approval = _extract_approval(event)
                            if approval is not None:
                                _mark_session_awaiting_approval(session, approval)
                                manager.touch_session(session)
                                manager.persist_session(session)
                                raise HTTPException(status_code=409, detail="Codex approval required")
                except asyncio.CancelledError:
                    agent_manager.cancel(job.job_id)
                    await agent_manager.wait(job.job_id)
                    raise

                if result is None or result.status != AgentRunnerStatus.COMPLETED:
                    error = result.error if result else "Codex run disappeared"
                    raise RuntimeError(error or "Codex run failed")

                output_text = _read_output(result)
                _append_session_messages(session, user_input, output_text)
                return {
                    "id": chunk_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": output_text},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": usage,
                    "session_id": session.session_id,
                }
        except asyncio.CancelledError:
            session.status = "idle"
            raise HTTPException(status_code=499, detail="Request cancelled")
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Codex chat failed: {}", exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        finally:
            session.current_task = None
            if session.status == "running":
                session.status = "idle"
            manager.touch_session(session)
            manager.persist_session(session)


async def stream_codex_chat_as_sse(
    *,
    session: Session,
    user_input: str,
    model: str,
    system_prompt: str | None,
    manager: SessionManager,
    agent_manager: ExternalAgentManager,
    config: Config,
) -> AsyncGenerator[str, None]:
    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    emitted_text = ""
    with session_context(session.session_id):
        job: ExternalAgentJob | None = None
        try:
            async with session.lock:
                session.current_task = asyncio.current_task()
                session.status = "running"
                session.pending_question = None
                session.pending_options = None
                session.pending_permission_request = None
                manager.touch_session(session)

                yield _chunk(chunk_id, model, created, {"role": "assistant"})
                prompt = build_codex_chat_prompt(session=session, user_input=user_input, system_prompt=system_prompt)
                job = _start_chat_run(session=session, prompt=prompt, config=config, agent_manager=agent_manager)

                offset = 0
                latest_usage = _usage()
                last_heartbeat = time.monotonic()
                while job.status == AgentRunnerStatus.RUNNING:
                    events, offset = _read_new_events(job.events_file, offset) if job.events_file else ([], offset)
                    for event in events:
                        usage_event = _extract_usage_event(event)
                        if usage_event is not None:
                            latest_usage = usage_event
                            continue
                        approval = _extract_approval(event)
                        if approval is not None:
                            _mark_session_awaiting_approval(session, approval)
                            manager.touch_session(session)
                            manager.persist_session(session)
                            yield f"data: {json.dumps({'type': 'approval_required', 'approval': approval}, ensure_ascii=False)}\n\n"
                            continue
                        tool_event = _extract_tool_event(event)
                        if tool_event is not None:
                            yield f"data: {json.dumps(tool_event, ensure_ascii=False)}\n\n"
                            continue
                        delta = _extract_event_delta(event)
                        if delta:
                            emitted_text += delta
                            yield _chunk(chunk_id, model, created, {"content": delta})
                    now = time.monotonic()
                    if now - last_heartbeat >= _HEARTBEAT_SECONDS:
                        yield f"data: {json.dumps({'type': 'heartbeat', 'ts': int(time.time())})}\n\n"
                        last_heartbeat = now
                    await asyncio.sleep(0.05)

                result = await agent_manager.wait(job.job_id)
                if job.events_file:
                    events, offset = _read_new_events(job.events_file, offset)
                    for event in events:
                        usage_event = _extract_usage_event(event)
                        if usage_event is not None:
                            latest_usage = usage_event
                            continue
                        approval = _extract_approval(event)
                        if approval is not None:
                            _mark_session_awaiting_approval(session, approval)
                            manager.touch_session(session)
                            manager.persist_session(session)
                            yield f"data: {json.dumps({'type': 'approval_required', 'approval': approval}, ensure_ascii=False)}\n\n"
                            continue
                        tool_event = _extract_tool_event(event)
                        if tool_event is not None:
                            yield f"data: {json.dumps(tool_event, ensure_ascii=False)}\n\n"
                            continue
                        delta = _extract_event_delta(event)
                        if delta:
                            emitted_text += delta
                            yield _chunk(chunk_id, model, created, {"content": delta})

                if result is None or result.status != AgentRunnerStatus.COMPLETED:
                    error = result.error if result else "Codex run disappeared"
                    raise RuntimeError(error or "Codex run failed")

                output_text = _read_output(result)
                if not emitted_text and output_text:
                    emitted_text = output_text
                    yield _chunk(chunk_id, model, created, {"content": output_text})

                _append_session_messages(session, user_input, output_text or emitted_text)
                if latest_usage["total_tokens"] > 0:
                    yield f"data: {json.dumps({'type': 'usage', 'usage': latest_usage}, ensure_ascii=False)}\n\n"
                finish_chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": _usage(),
                }
                yield f"data: {json.dumps(finish_chunk, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            if job is not None:
                agent_manager.cancel(job.job_id)
                await agent_manager.wait(job.job_id)
            session.status = "idle"
            yield f"data: {json.dumps({'error': {'message': 'Request cancelled', 'type': 'cancelled'}})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            logger.exception("Codex stream failed: {}", exc)
            error_data = {"error": {"message": str(exc), "type": "server_error"}}
            yield f"data: {json.dumps(error_data, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            session.current_task = None
            if session.status == "running":
                session.status = "idle"
            manager.touch_session(session)
            manager.persist_session(session)
