"""query() async generator yield -> SSE 事件适配层

将 agent_loop.query() 产生的 Message / StreamEvent 转换为
OpenAI 兼容的 SSE data 行（chat.completion.chunk 格式）。
"""

import json
import time
from collections.abc import AsyncGenerator
from typing import Any
from uuid import uuid4

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolUseContext
from ripple.messages.types import AgentStopEvent, AssistantMessage, Message, RequestStartEvent, StreamEvent
from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger

logger = get_logger("server.sse")


def _save_to_history(history_messages: list[Message], user_input: str, new_messages: list[Message]) -> None:
    """将本轮内部消息对象原样追加到历史，保留完整工具轨迹。"""
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


async def stream_query_as_sse(
    user_input: str,
    context: ToolUseContext,
    client: OpenRouterClient,
    model: str,
    max_turns: int,
    history_messages: list[Message] | None = None,
    system_prompt: str | None = None,
    thinking: bool = False,
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
    new_messages: list[Message] = []
    finish_reason = "stop"
    # 跟踪 tool_use id -> name 的映射，用于识别 task 工具的 result
    tool_id_to_name: dict[str, str] = {}
    # 跟踪任务状态用于发送 task_progress
    task_tracker: dict[str, dict[str, Any]] = {}

    heartbeat_interval = 8

    async def _heartbeat_wrapper():
        """包装 query() 生成器，在长时间无输出时发送心跳"""
        gen = query(
            user_input=user_input,
            context=context,
            client=client,
            model=model,
            max_turns=max_turns,
            thinking=thinking,
            history_messages=history_messages,
            system_prompt=system_prompt,
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

    try:
        async for item in _heartbeat_wrapper():
            if isinstance(item, StreamEvent) and item.type == "heartbeat":
                yield _make_tool_event("heartbeat", item.data or {})
                continue

            if isinstance(item, AgentStopEvent):
                if item.stop_reason in ("ask_user", "permission_request"):
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
                    usage_info["prompt_tokens"] = usage_info.get("prompt_tokens", 0) + usage.get("input_tokens", 0)
                    usage_info["completion_tokens"] = usage_info.get("completion_tokens", 0) + usage.get(
                        "output_tokens", 0
                    )

                content = item.message.get("content", [])
                for block in content:
                    if not isinstance(block, dict):
                        continue

                    if block.get("type") == "text":
                        pass

                    elif block.get("type") == "tool_use":
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
                        yield _make_tool_event(
                            "tool_result",
                            {
                                "tool_use_id": tool_use_id,
                                "content": result_content[:500]
                                if isinstance(result_content, str)
                                else str(result_content)[:500],
                                "is_error": block.get("is_error", False),
                            },
                        )

                        # 对 Task 工具结果发送进度事件
                        originating_tool = tool_id_to_name.get(tool_use_id, "")
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
    client: OpenRouterClient,
    model: str,
    max_turns: int,
    history_messages: list[Message] | None = None,
    system_prompt: str | None = None,
    thinking: bool = False,
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
    new_messages: list[Message] = []
    finish_reason = "stop"

    try:
        async for item in query(
            user_input=user_input,
            context=context,
            client=client,
            model=model,
            max_turns=max_turns,
            thinking=thinking,
            history_messages=history_messages,
            system_prompt=system_prompt,
        ):
            if isinstance(item, AgentStopEvent):
                if item.stop_reason in ("ask_user", "permission_request"):
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
                    usage_info["prompt_tokens"] = usage_info.get("prompt_tokens", 0) + usage.get("input_tokens", 0)
                    usage_info["completion_tokens"] = usage_info.get("completion_tokens", 0) + usage.get(
                        "output_tokens", 0
                    )

                for block in item.message.get("content", []):
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and block.get("text", "").strip():
                        pass
                    elif block.get("type") == "tool_use":
                        tool_calls.append(
                            {
                                "id": block.get("id", ""),
                                "type": "function",
                                "function": {
                                    "name": block.get("name", ""),
                                    "arguments": json.dumps(block.get("input", {}), ensure_ascii=False),
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
            },
            "stop_metadata": stop_metadata,
        }

    except asyncio.CancelledError:
        logger.info("collect_query_response 被取消 (CancelledError)")
        if history_messages is not None:
            _save_to_history(history_messages, user_input, new_messages)
        raise
