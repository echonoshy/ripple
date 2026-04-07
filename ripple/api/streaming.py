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
    current_tool_use: Dict[str, Any] | None = None

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
                if tool_call.function:
                    if current_tool_use is None:
                        # 开始新的工具调用
                        current_tool_use = {
                            "type": "tool_use",
                            "id": tool_call.id or str(uuid4()),
                            "name": tool_call.function.name or "",
                            "input": {},
                        }
                    else:
                        # 累积工具调用参数
                        if tool_call.function.arguments:
                            # 这里需要解析 JSON 字符串
                            import json

                            try:
                                args = json.loads(tool_call.function.arguments)
                                current_tool_use["input"].update(args)
                            except json.JSONDecodeError:
                                # 部分 JSON，继续累积
                                pass

        # 检查是否完成
        if choice.finish_reason:
            # 添加累积的文本
            if current_text:
                accumulated_content.append({"type": "text", "text": current_text})

            # 添加工具调用
            if current_tool_use:
                accumulated_content.append(current_tool_use)

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
            current_tool_use = None
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
