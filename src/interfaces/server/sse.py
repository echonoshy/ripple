"""query() async generator yield -> SSE 事件适配层

将 agent_loop.query() 产生的 Message / StreamEvent 转换为
OpenAI 兼容的 SSE data 行（chat.completion.chunk 格式）。
"""

import json
import time
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any
from uuid import uuid4

from ripple.api.client import LLMClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolUseContext
from ripple.messages.types import AgentStopEvent, AssistantMessage, Message, RequestStartEvent, StreamEvent
from ripple.messages.utils import create_user_message
from ripple.tasks.manager import get_task_manager
from ripple.tasks.models import TaskStatus
from ripple.utils.logger import get_logger

logger = get_logger("server.sse")


def _save_to_history(history_messages: list[Message], user_input: str, new_messages: list[Message]) -> None:
    """将本轮消息追加到历史。

    直接追加原始消息对象。跨 agent loop 的上下文清理由
    clean_messages_for_model_context() 在传给模型时完成，
    不修改 session.messages（保持完整以供 Web 展示）。
    """
    history_messages.append(create_user_message(content=user_input))
    history_messages.extend(new_messages)


def _extract_stop_metadata(stop_reason: str, new_messages: list[Message]) -> dict[str, Any]:
    """从本轮消息中提取暂停所需元数据。"""
    if stop_reason == "permission_request":
        for msg in reversed(new_messages):
            if getattr(msg, "type", None) != "user":
                continue

            for block in reversed(msg.message.get("content", [])):
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue

                content = block.get("content", "")
                if not isinstance(content, str) or "Awaiting user permission" not in content:
                    continue

                tool_name = block.get("tool_name")
                if isinstance(tool_name, str):
                    return {
                        "tool": tool_name,
                        "params": {},
                        "riskLevel": "dangerous",
                    }

        return {}

    if stop_reason != "ask_user":
        return {}

    for msg in reversed(new_messages):
        if not isinstance(msg, AssistantMessage):
            continue

        for block in reversed(msg.message.get("content", [])):
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use" or block.get("name") != "AskUser":
                continue

            tool_input = block.get("input", {})
            if not isinstance(tool_input, dict):
                tool_input = {}

            options = tool_input.get("options")
            return {
                "question": tool_input.get("question", ""),
                "options": options if isinstance(options, list) else [],
            }

    return {}


def _make_chunk(
    chunk_id: str,
    model: str,
    created: int,
    delta: dict[str, Any],
    finish_reason: str | None = None,
) -> str:
    """构建一个 OpenAI chat.completion.chunk JSON 行"""
    payload = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _make_tool_event(event_type: str, data: dict[str, Any]) -> str:
    """构建 Ripple 扩展事件（tool_call / tool_result），用于丰富流式输出"""
    payload = {"type": event_type, **data}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _extract_task_event(
    tool_name: str,
    result_content: str | Any,
    task_tracker: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """从 Task 工具结果中提取事件信息"""
    try:
        if isinstance(result_content, str):
            data = json.loads(result_content)
        else:
            data = result_content

        if not isinstance(data, dict):
            return None

        task_id = data.get("task_id", "")
        subject = data.get("subject", "")
        status = data.get("status", "pending")

        if tool_name == "TaskCreate":
            task_tracker[task_id] = {"id": task_id, "subject": subject, "status": "pending"}
            return {
                "type": "task_created",
                "data": {"id": task_id, "subject": subject, "status": "pending"},
            }
        elif tool_name == "TaskUpdate":
            if task_id in task_tracker:
                task_tracker[task_id]["status"] = status
                if subject:
                    task_tracker[task_id]["subject"] = subject
            else:
                task_tracker[task_id] = {"id": task_id, "subject": subject, "status": status}
            return {
                "type": "task_updated",
                "data": {"id": task_id, "subject": task_tracker[task_id].get("subject", ""), "status": status},
            }
    except (json.JSONDecodeError, TypeError, KeyError):
        pass

    return None


def _build_task_progress(task_tracker: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """构建任务进度信息"""
    total = len(task_tracker)
    completed = sum(1 for t in task_tracker.values() if t.get("status") == "completed")
    current = next(
        (t.get("subject", "") for t in task_tracker.values() if t.get("status") == "in_progress"),
        None,
    )
    return {"completed": completed, "total": total, "currentTask": current}


def _load_existing_tasks(session_runtime_dir: Path | None) -> dict[str, dict[str, Any]]:
    """从 TaskManager 加载已有任务，预填充 task_tracker。

    这样 task_progress 的 total 从一开始就反映真实的任务总数，
    而不是在 TaskUpdate 事件逐个到来时递增。
    """
    tracker: dict[str, dict[str, Any]] = {}
    if session_runtime_dir is None:
        return tracker
    try:
        task_path = session_runtime_dir / "tasks.json"
        if not task_path.exists():
            return tracker
        tm = get_task_manager(task_path)
        for task in tm.list_tasks():
            if task.status == TaskStatus.DELETED:
                continue
            tracker[task.id] = {
                "id": task.id,
                "subject": task.subject,
                "status": task.status.value,
            }
    except Exception:
        logger.debug("预加载任务失败，将使用空 task_tracker")
    return tracker


async def stream_query_as_sse(
    user_input: str,
    context: ToolUseContext,
    client: LLMClient,
    model: str,
    max_turns: int,
    history_messages: list[Message] | None = None,
    system_prompt: str | None = None,
    thinking: bool | None = None,
    context_manager=None,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> AsyncGenerator[str, None]:
    """消费 query() 的 async generator，产出 SSE data 行。

    Yields:
        符合 OpenAI SSE 格式的字符串行（包含 `data: ...\\n\\n`）。
    """
    import asyncio

    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    first_chunk = True
    accumulated_text = ""
    accumulated_tool_calls: list[dict[str, Any]] = []
    usage_info: dict[str, int] = {}
    last_prompt_tokens: int = 0
    new_messages: list[Message] = []
    finish_reason = "stop"
    # 跟踪 tool_use id -> name 的映射，用于识别 task 工具的 result
    tool_id_to_name: dict[str, str] = {}
    # 从 TaskManager 预加载已有任务，避免 task_progress.total 从 0 递增
    task_tracker: dict[str, dict[str, Any]] = _load_existing_tasks(context.session_runtime_dir)

    heartbeat_interval = 8

    # 跨 loop 上下文清理：传给模型的是精简版，session.messages 保持完整
    if context_manager and history_messages:
        model_history = context_manager.prepare_model_messages(history_messages)
    else:
        model_history = history_messages

    async def _heartbeat_wrapper():
        """包装 query() 生成器，在长时间无输出时发送心跳"""
        gen = query(
            user_input=user_input,
            context=context,
            client=client,
            model=model,
            max_turns=max_turns,
            thinking=thinking,
            history_messages=model_history,
            system_prompt=system_prompt,
            compactor=context_manager.compactor if context_manager else None,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        pending_next = asyncio.ensure_future(gen.__anext__())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(asyncio.shield(pending_next), timeout=heartbeat_interval)
                    yield item
                    pending_next = asyncio.ensure_future(gen.__anext__())
                except asyncio.TimeoutError:
                    yield StreamEvent(type="heartbeat", data={"ts": int(time.time())})
                except StopAsyncIteration:
                    break
        finally:
            if not pending_next.done():
                pending_next.cancel()
                try:
                    await pending_next
                except (asyncio.CancelledError, StopAsyncIteration):
                    pass

    # 在流开始时发送已有任务的状态，让前端立即获得正确的任务列表
    if task_tracker:
        for tdata in task_tracker.values():
            yield _make_tool_event("task_created", tdata)
        yield _make_tool_event("task_progress", _build_task_progress(task_tracker))

    try:
        async for item in _heartbeat_wrapper():
            if isinstance(item, StreamEvent) and item.type == "heartbeat":
                yield _make_tool_event("heartbeat", item.data or {})
                continue

            if isinstance(item, AgentStopEvent):
                if item.stop_reason in ("ask_user", "permission_request", "max_turns"):
                    finish_reason = item.stop_reason
                metadata = item.metadata or _extract_stop_metadata(item.stop_reason, new_messages)
                yield _make_tool_event(
                    "agent_stop",
                    {
                        "stop_reason": item.stop_reason,
                        "metadata": metadata,
                    },
                )
                continue

            if isinstance(item, RequestStartEvent):
                if not first_chunk:
                    yield _make_tool_event("new_turn", {})
                continue

            if isinstance(item, StreamEvent):
                if item.type == "stream_start":
                    if first_chunk:
                        yield _make_chunk(chunk_id, model, created, {"role": "assistant"})
                        first_chunk = False

                elif item.type == "stream_chunk":
                    text = (item.data or {}).get("text", "")
                    if text:
                        accumulated_text += text
                        yield _make_chunk(chunk_id, model, created, {"content": text})

                elif item.type == "stream_end":
                    pass

            elif isinstance(item, AssistantMessage):
                new_messages.append(item)

                usage = item.message.get("usage", {})
                if usage:
                    input_tokens = usage.get("input_tokens", 0)
                    usage_info["prompt_tokens"] = usage_info.get("prompt_tokens", 0) + input_tokens
                    usage_info["completion_tokens"] = usage_info.get("completion_tokens", 0) + usage.get(
                        "output_tokens", 0
                    )
                    if input_tokens > 0:
                        last_prompt_tokens = input_tokens

                content = item.message.get("content", [])
                for block in content:
                    if not isinstance(block, dict):
                        continue

                    if block.get("type") == "tool_use":
                        tool_name = block.get("name", "")
                        tool_id = block.get("id", "")
                        tool_input = block.get("input", {})
                        tool_call_data = {
                            "name": tool_name,
                            "id": tool_id,
                            "input": tool_input,
                        }
                        accumulated_tool_calls.append(tool_call_data)
                        tool_id_to_name[tool_id] = tool_name

                        yield _make_tool_event("tool_call", tool_call_data)

            elif hasattr(item, "type") and item.type == "user":
                new_messages.append(item)

                if getattr(item, "is_meta", False):
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            meta_text = block.get("text", "")
                            if meta_text:
                                if not first_chunk:
                                    yield _make_chunk(
                                        chunk_id,
                                        model,
                                        created,
                                        {"content": f"\n\n**System Notification:**\n{meta_text}"},
                                    )
                                else:
                                    yield _make_chunk(chunk_id, model, created, {"role": "assistant"})
                                    yield _make_chunk(
                                        chunk_id, model, created, {"content": f"**System Notification:**\n{meta_text}"}
                                    )
                                    first_chunk = False

                content = item.message.get("content", [])
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        tool_use_id = block.get("tool_use_id", "")
                        result_content = block.get("content", "")
                        is_error = block.get("is_error", False)
                        originating_tool = tool_id_to_name.get(tool_use_id, "")

                        yield _make_tool_event(
                            "tool_result",
                            {
                                "tool_use_id": tool_use_id,
                                "content": result_content[:500]
                                if isinstance(result_content, str)
                                else str(result_content)[:500],
                                "is_error": is_error,
                            },
                        )

                        # 对 Task 工具结果发送进度事件
                        if originating_tool in ("TaskCreate", "TaskUpdate"):
                            task_event = _extract_task_event(originating_tool, result_content, task_tracker)
                            if task_event:
                                yield _make_tool_event(task_event["type"], task_event["data"])
                                yield _make_tool_event("task_progress", _build_task_progress(task_tracker))

        if history_messages is not None:
            _save_to_history(history_messages, user_input, new_messages)

        finish_chunk = {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
        }
        if usage_info:
            finish_chunk["usage"] = {
                "prompt_tokens": usage_info.get("prompt_tokens", 0),
                "completion_tokens": usage_info.get("completion_tokens", 0),
                "total_tokens": usage_info.get("prompt_tokens", 0) + usage_info.get("completion_tokens", 0),
                "last_prompt_tokens": last_prompt_tokens,
            }
        yield f"data: {json.dumps(finish_chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    except asyncio.CancelledError:
        logger.info("stream_query_as_sse 被取消 (CancelledError)")
        if history_messages is not None:
            _save_to_history(history_messages, user_input, new_messages)
        raise


async def collect_query_response(
    user_input: str,
    context: ToolUseContext,
    client: LLMClient,
    model: str,
    max_turns: int,
    history_messages: list[Message] | None = None,
    system_prompt: str | None = None,
    thinking: bool | None = None,
    context_manager=None,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """消费 query() 的 async generator，收集为完整的 ChatCompletion 响应。

    用于 stream=false 的请求。
    """
    import asyncio

    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    accumulated_text = ""
    tool_calls: list[dict[str, Any]] = []
    usage_info: dict[str, int] = {}
    last_prompt_tokens: int = 0
    new_messages: list[Message] = []
    finish_reason = "stop"
    stop_metadata: dict[str, Any] = {}
    tool_id_to_name: dict[str, str] = {}

    if context_manager and history_messages:
        model_history = context_manager.prepare_model_messages(history_messages)
    else:
        model_history = history_messages

    try:
        async for item in query(
            user_input=user_input,
            context=context,
            client=client,
            model=model,
            max_turns=max_turns,
            thinking=thinking,
            history_messages=model_history,
            system_prompt=system_prompt,
            compactor=context_manager.compactor if context_manager else None,
            temperature=temperature,
            max_tokens=max_tokens,
        ):
            if isinstance(item, AgentStopEvent):
                if item.stop_reason in ("ask_user", "permission_request", "max_turns"):
                    finish_reason = item.stop_reason
                    stop_metadata = item.metadata or _extract_stop_metadata(item.stop_reason, new_messages)
                continue

            if isinstance(item, (StreamEvent, RequestStartEvent)):
                if isinstance(item, StreamEvent) and item.type == "stream_chunk":
                    text = (item.data or {}).get("text", "")
                    accumulated_text += text
                continue

            if isinstance(item, AssistantMessage):
                new_messages.append(item)

                usage = item.message.get("usage", {})
                if usage:
                    input_tokens = usage.get("input_tokens", 0)
                    usage_info["prompt_tokens"] = usage_info.get("prompt_tokens", 0) + input_tokens
                    usage_info["completion_tokens"] = usage_info.get("completion_tokens", 0) + usage.get(
                        "output_tokens", 0
                    )
                    if input_tokens > 0:
                        last_prompt_tokens = input_tokens

                for block in item.message.get("content", []):
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use":
                        tool_name = block.get("name", "")
                        tool_id = block.get("id", "")
                        tool_input = block.get("input", {})
                        tool_id_to_name[tool_id] = tool_name

                        tool_calls.append(
                            {
                                "id": tool_id,
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": json.dumps(tool_input, ensure_ascii=False),
                                },
                            }
                        )

            elif hasattr(item, "type") and item.type == "user":
                new_messages.append(item)

                if getattr(item, "is_meta", False):
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            meta_text = block.get("text", "")
                            if meta_text:
                                accumulated_text += f"\n\n**System Notification:**\n{meta_text}"

        if history_messages is not None:
            _save_to_history(history_messages, user_input, new_messages)

        message: dict[str, Any] = {
            "role": "assistant",
            "content": accumulated_text or None,
        }
        if tool_calls:
            message["tool_calls"] = tool_calls

        return {
            "id": chunk_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": finish_reason,
                }
            ],
            "usage": {
                "prompt_tokens": usage_info.get("prompt_tokens", 0),
                "completion_tokens": usage_info.get("completion_tokens", 0),
                "total_tokens": usage_info.get("prompt_tokens", 0) + usage_info.get("completion_tokens", 0),
                "last_prompt_tokens": last_prompt_tokens,
            },
            "stop_metadata": stop_metadata,
        }

    except asyncio.CancelledError:
        logger.info("collect_query_response 被取消 (CancelledError)")
        if history_messages is not None:
            _save_to_history(history_messages, user_input, new_messages)
        raise
