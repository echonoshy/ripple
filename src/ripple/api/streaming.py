"""流式响应处理"""

from typing import Any, AsyncGenerator
from uuid import uuid4

from ripple.messages.types import AssistantMessage, StreamEvent
from ripple.messages.utils import create_assistant_message as create_msg
from ripple.utils.logger import get_logger

logger = get_logger("api.streaming")


async def process_stream_response(
    stream: AsyncGenerator[Any, None],
) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
    """处理流式响应，转换为 AssistantMessage 和 StreamEvent

    在流式传输过程中，每个 text delta 会 yield 一个 StreamEvent(stream_chunk)，
    让下游（如 CLI）可以实时显示文本。完整的 AssistantMessage 在 finish_reason 时 yield。

    事件顺序: stream_start → stream_chunk* → stream_end → AssistantMessage

    Args:
        stream: OpenAI SDK 的流式响应

    Yields:
        StreamEvent 或 AssistantMessage
    """
    current_message_id = str(uuid4())
    current_text = ""
    tool_calls_map: dict[int, dict[str, Any]] = {}

    chunk_count = 0
    yielded = False
    text_streaming_started = False
    last_usage: dict[str, int] = {}

    async for chunk in stream:
        chunk_count += 1

        if not chunk.choices:
            if hasattr(chunk, "usage") and chunk.usage:
                last_usage = {
                    "input_tokens": chunk.usage.prompt_tokens or 0,
                    "output_tokens": chunk.usage.completion_tokens or 0,
                }
            continue

        choice = chunk.choices[0]
        delta = choice.delta

        # 处理文本内容：逐 chunk 推送给下游
        if delta.content:
            if not text_streaming_started:
                yield StreamEvent(type="stream_start")
                text_streaming_started = True
            current_text += delta.content
            yield StreamEvent(type="stream_chunk", data={"text": delta.content})

        # 处理工具调用
        if delta.tool_calls:
            for tool_call in delta.tool_calls:
                index = tool_call.index

                if index not in tool_calls_map:
                    tool_calls_map[index] = {
                        "type": "tool_use",
                        "id": "",
                        "name": "",
                        "args_buffer": "",
                    }

                if tool_call.id:
                    tool_calls_map[index]["id"] = tool_call.id

                if tool_call.function:
                    if tool_call.function.name:
                        tool_calls_map[index]["name"] = tool_call.function.name
                    if tool_call.function.arguments:
                        tool_calls_map[index]["args_buffer"] += tool_call.function.arguments

        # 检查是否完成
        if choice.finish_reason:
            logger.debug("流完成: finish_reason={}, chunks={}", choice.finish_reason, chunk_count)

            if text_streaming_started:
                yield StreamEvent(type="stream_end")
                text_streaming_started = False

            yield _build_message(current_text, tool_calls_map, chunk, current_message_id)
            yielded = True

            current_text = ""
            tool_calls_map = {}
            current_message_id = str(uuid4())

    # 流结束后的 fallback：如果有未 yield 的内容（LiteLLM 可能不发送 finish_reason）
    if not yielded:
        if current_text or tool_calls_map:
            logger.warning(
                "流结束但未收到 finish_reason，fallback yield 已积累内容 (chunks={}, text_len={}, tool_calls={})",
                chunk_count,
                len(current_text),
                len(tool_calls_map),
            )
            if text_streaming_started:
                yield StreamEvent(type="stream_end")

            yield _build_message(current_text, tool_calls_map, None, current_message_id, last_usage)
        else:
            logger.warning("流结束且无任何内容 (chunks={})", chunk_count)


def _build_message(
    current_text: str,
    tool_calls_map: dict[int, dict[str, Any]],
    chunk: Any,
    message_id: str,
    fallback_usage: dict[str, int] | None = None,
) -> AssistantMessage:
    """从积累的流式数据构建 AssistantMessage"""
    import json

    content: list[dict[str, Any]] = []

    if current_text:
        content.append({"type": "text", "text": current_text})

    for index in sorted(tool_calls_map.keys()):
        tool_data = tool_calls_map[index]
        tool_input = {}
        args_parse_error = False
        if tool_data["args_buffer"]:
            try:
                tool_input = json.loads(tool_data["args_buffer"])
            except json.JSONDecodeError:
                args_parse_error = True
                logger.warning(
                    "工具参数 JSON 解析失败: name={}, raw={}", tool_data["name"], tool_data["args_buffer"][:200]
                )
        tool_id = tool_data["id"] or str(uuid4())
        if args_parse_error:
            content.append(
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": tool_data["name"],
                    "input": {},
                    "_args_parse_error": tool_data["args_buffer"][:200],
                }
            )
        else:
            content.append(
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": tool_data["name"],
                    "input": tool_input,
                }
            )

    usage = fallback_usage or {}
    if chunk is not None and hasattr(chunk, "usage") and chunk.usage:
        usage = {
            "input_tokens": chunk.usage.prompt_tokens or 0,
            "output_tokens": chunk.usage.completion_tokens or 0,
        }

    return create_msg(content=content, message_id=message_id, usage=usage)


async def collect_stream_response(stream: AsyncGenerator[Any, None]) -> AssistantMessage:
    """收集完整的流式响应（跳过 StreamEvent，只返回第一条 AssistantMessage）

    Args:
        stream: OpenAI SDK 的流式响应

    Returns:
        完整的 AssistantMessage
    """
    async for item in process_stream_response(stream):
        if isinstance(item, AssistantMessage):
            return item

    return create_msg(content=[{"type": "text", "text": ""}])
