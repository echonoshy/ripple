"""流式响应处理"""

from typing import Any, AsyncGenerator, Dict, List
from uuid import uuid4

from ripple.messages.types import AssistantMessage
from ripple.messages.utils import create_assistant_message as create_msg


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

    async for chunk in stream:
        if not chunk.choices:
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
            # 添加累积的文本
            if current_text:
                accumulated_content.append({"type": "text", "text": current_text})

            # 添加所有工具调用
            for index in sorted(tool_calls_map.keys()):
                tool_data = tool_calls_map[index]

                # 解析 JSON 参数
                import json
                tool_input = {}
                if tool_data["args_buffer"]:
                    try:
                        tool_input = json.loads(tool_data["args_buffer"])
                    except json.JSONDecodeError:
                        # JSON 解析失败，使用空字典
                        tool_input = {}

                accumulated_content.append({
                    "type": "tool_use",
                    "id": tool_data["id"] or str(uuid4()),
                    "name": tool_data["name"],
                    "input": tool_input,
                })

            # 创建最终消息
            usage = {}
            if hasattr(chunk, "usage") and chunk.usage:
                usage = {
                    "input_tokens": chunk.usage.prompt_tokens or 0,
                    "output_tokens": chunk.usage.completion_tokens or 0,
                }

            yield create_msg(
                content=accumulated_content,
                message_id=current_message_id,
                usage=usage,
            )

            # 重置状态
            current_text = ""
            tool_calls_map = {}
            accumulated_content = []
            current_message_id = str(uuid4())


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
