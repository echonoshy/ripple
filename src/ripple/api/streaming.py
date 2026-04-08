"""流式响应处理"""

from typing import Any, AsyncGenerator, Dict, List
from uuid import uuid4

from ripple.messages.types import AssistantMessage
from ripple.messages.utils import create_assistant_message as create_msg
from ripple.utils.logger import get_logger

logger = get_logger("api.streaming")


async def process_stream_response(
    stream: AsyncGenerator[Any, None],
) -> AsyncGenerator[AssistantMessage, None]:
    """处理流式响应，转换为 AssistantMessage

    Args:
        stream: OpenAI SDK 的流式响应

    Yields:
        AssistantMessage 对象
    """
    current_message_id = str(uuid4())
    accumulated_content: List[Dict[str, Any]] = []
    current_text = ""
    # 支持多个工具调用，使用 index 作为 key
    tool_calls_map: Dict[int, Dict[str, Any]] = {}

    chunk_count = 0
    yielded = False
    last_usage: Dict[str, int] = {}

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

        # 处理文本内容
        if delta.content:
            current_text += delta.content

        # 处理工具调用
        if delta.tool_calls:
            for tool_call in delta.tool_calls:
                index = tool_call.index

                # 初始化工具调用
                if index not in tool_calls_map:
                    tool_calls_map[index] = {
                        "type": "tool_use",
                        "id": "",
                        "name": "",
                        "args_buffer": "",
                    }

                # 更新工具调用信息
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
            yield _build_message(current_text, tool_calls_map, accumulated_content, chunk, current_message_id)
            yielded = True

            # 重置状态
            current_text = ""
            tool_calls_map = {}
            accumulated_content = []
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
            yield _build_message(
                current_text, tool_calls_map, accumulated_content, None, current_message_id, last_usage
            )
        else:
            logger.warning("流结束且无任何内容 (chunks={})", chunk_count)


def _build_message(
    current_text: str,
    tool_calls_map: Dict[int, Dict[str, Any]],
    accumulated_content: List[Dict[str, Any]],
    chunk: Any,
    message_id: str,
    fallback_usage: Dict[str, int] | None = None,
) -> AssistantMessage:
    """从积累的流式数据构建 AssistantMessage"""
    import json

    content = list(accumulated_content)

    if current_text:
        content.append({"type": "text", "text": current_text})

    for index in sorted(tool_calls_map.keys()):
        tool_data = tool_calls_map[index]
        tool_input = {}
        if tool_data["args_buffer"]:
            try:
                tool_input = json.loads(tool_data["args_buffer"])
            except json.JSONDecodeError:
                logger.warning(
                    "工具参数 JSON 解析失败: name={}, raw={}", tool_data["name"], tool_data["args_buffer"][:200]
                )
        content.append(
            {
                "type": "tool_use",
                "id": tool_data["id"] or str(uuid4()),
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
    """收集完整的流式响应

    Args:
        stream: OpenAI SDK 的流式响应

    Returns:
        完整的 AssistantMessage
    """
    async for message in process_stream_response(stream):
        return message

    # 如果没有消息，返回空消息
    return create_msg(content=[{"type": "text", "text": ""}])
