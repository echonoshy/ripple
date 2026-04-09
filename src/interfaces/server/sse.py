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
from ripple.messages.types import AssistantMessage, Message, RequestStartEvent, StreamEvent
from ripple.utils.logger import get_logger

logger = get_logger("server.sse")


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
    from ripple.messages.utils import create_user_message
    from ripple.messages.types import AssistantMessage

    if history_messages is not None:
        history_messages.append(create_user_message(content=user_input))

    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    first_chunk = True
    accumulated_text = ""
    accumulated_tool_calls: list[dict[str, Any]] = []
    usage_info: dict[str, int] = {}

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
            if isinstance(item, RequestStartEvent):
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
                if history_messages is not None:
                    history_messages.append(item)

                usage = item.message.get("usage", {})
                if usage:
                    usage_info["prompt_tokens"] = usage_info.get("prompt_tokens", 0) + usage.get("input_tokens", 0)
                    usage_info["completion_tokens"] = usage_info.get("completion_tokens", 0) + usage.get("output_tokens", 0)

                content = item.message.get("content", [])
                for block in content:
                    if not isinstance(block, dict):
                        continue

                    if block.get("type") == "text":
                        pass

                    elif block.get("type") == "tool_use":
                        tool_call_data = {
                            "name": block.get("name", ""),
                            "id": block.get("id", ""),
                            "input": block.get("input", {}),
                        }
                        accumulated_tool_calls.append(tool_call_data)
                        yield _make_tool_event("tool_call", tool_call_data)

            elif hasattr(item, "type") and item.type == "user":
                if history_messages is not None:
                    history_messages.append(item)

                content = item.message.get("content", [])
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        yield _make_tool_event(
                            "tool_result",
                            {
                                "tool_use_id": block.get("tool_use_id", ""),
                                "content": block.get("content", "")[:500],
                                "is_error": block.get("is_error", False),
                            },
                        )

        finish_chunk = {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
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
        if history_messages is not None and (accumulated_text or accumulated_tool_calls):
            content = []
            if accumulated_text:
                content.append({"type": "text", "text": accumulated_text})
            for tc in accumulated_tool_calls:
                content.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["input"]})
            
            partial_msg = AssistantMessage(
                type="assistant",
                message={"content": content}
            )
            history_messages.append(partial_msg)
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
    from ripple.messages.utils import create_user_message
    from ripple.messages.types import AssistantMessage

    if history_messages is not None:
        history_messages.append(create_user_message(content=user_input))

    chunk_id = f"chatcmpl-{uuid4().hex[:24]}"
    created = int(time.time())
    accumulated_text = ""
    tool_calls: list[dict[str, Any]] = []
    usage_info: dict[str, int] = {}

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
            if isinstance(item, (StreamEvent, RequestStartEvent)):
                if isinstance(item, StreamEvent) and item.type == "stream_chunk":
                    text = (item.data or {}).get("text", "")
                    accumulated_text += text
                continue

            if isinstance(item, AssistantMessage):
                if history_messages is not None:
                    history_messages.append(item)

                usage = item.message.get("usage", {})
                if usage:
                    usage_info["prompt_tokens"] = usage_info.get("prompt_tokens", 0) + usage.get("input_tokens", 0)
                    usage_info["completion_tokens"] = usage_info.get("completion_tokens", 0) + usage.get("output_tokens", 0)

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
                if history_messages is not None:
                    history_messages.append(item)

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
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": usage_info.get("prompt_tokens", 0),
                "completion_tokens": usage_info.get("completion_tokens", 0),
                "total_tokens": usage_info.get("prompt_tokens", 0) + usage_info.get("completion_tokens", 0),
            },
        }

    except asyncio.CancelledError:
        logger.info("collect_query_response 被取消 (CancelledError)")
        if history_messages is not None and (accumulated_text or tool_calls):
            content = []
            if accumulated_text:
                content.append({"type": "text", "text": accumulated_text})
            for tc in tool_calls:
                # 注意这里 tool_calls 的格式和 stream 中略有不同
                content.append({
                    "type": "tool_use", 
                    "id": tc["id"], 
                    "name": tc["function"]["name"], 
                    "input": json.loads(tc["function"]["arguments"])
                })
            
            partial_msg = AssistantMessage(
                type="assistant",
                message={"content": content}
            )
            history_messages.append(partial_msg)
        raise
