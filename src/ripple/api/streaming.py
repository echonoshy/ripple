"""流式响应处理"""

from typing import Any, AsyncGenerator
from uuid import uuid4

from ripple.messages.types import AssistantMessage, StreamEvent
from ripple.messages.utils import create_assistant_message as create_msg
from ripple.utils.logger import get_logger

logger = get_logger("api.streaming")

# Reasoning 注入的开闭包标签。
# - 选用 <think>...</think> 是因为前端 MarkdownRenderer.parseThinkingBlocks 已经原生
#   按这对标签解析为可折叠的"思考块"，端到端无须改协议。
# - 若模型 content 本身输出了字面量 <think>，会被当成同样的折叠块处理；这种命中概率
#   极低，可接受。
_THINK_OPEN = "<think>\n"
_THINK_CLOSE = "\n</think>\n\n"


def _extract_reasoning_delta(delta: Any) -> str:
    """从 OpenAI SDK delta 对象中抽取 reasoning 文本片段。

    各家命名不统一：
      - OpenRouter / OpenAI o-系列：`delta.reasoning`
      - DeepSeek / 部分 vLLM 部署：`delta.reasoning_content`
    OpenAI SDK 的 BaseModel 默认 `extra="allow"`，未声明的字段会落到 model_extra；
    用 getattr 安全访问，缺字段返回空串。
    """
    raw = getattr(delta, "reasoning", None)
    if raw is None:
        raw = getattr(delta, "reasoning_content", None)
    if raw is None:
        # 兜底：从 pydantic 的 extra 里捞
        extra = getattr(delta, "model_extra", None) or {}
        raw = extra.get("reasoning") or extra.get("reasoning_content")
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    # 极少数 provider 把 reasoning 包成 list[{"type":"text","text":...}]，做最小兼容
    if isinstance(raw, list):
        parts: list[str] = []
        for item in raw:
            if isinstance(item, dict):
                t = item.get("text") or item.get("content")
                if isinstance(t, str):
                    parts.append(t)
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return ""


async def process_stream_response(
    stream: AsyncGenerator[Any, None],
) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
    """处理流式响应，转换为 AssistantMessage 和 StreamEvent

    在流式传输过程中，每个 text delta 会 yield 一个 StreamEvent(stream_chunk)，
    让下游（如 CLI）可以实时显示文本。完整的 AssistantMessage 在 finish_reason 时 yield。

    事件顺序: stream_start → stream_chunk* → stream_end → AssistantMessage

    Reasoning 处理：
        如果 delta 上有 reasoning / reasoning_content（OpenRouter Reasoning Tokens），
        我们把它包在 <think>...</think> 里和正常 content 共用同一条 stream_chunk 流，
        这样：
          1. 前端 MarkdownRenderer 直接渲染出可折叠的思考块
          2. 持久化到 messages.jsonl 时，思考内容随 text block 一并落盘，刷新可复现
          3. 下游 SSE 适配 / CLI 不需要新增事件类型
        当 reasoning 与正式回答交替出现时，自动收尾后再开新的 <think> 段。

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
    thinking_open = False  # 当前是否正处在 <think>...</think> 段中
    last_usage: dict[str, int] = {}

    def _emit(piece: str) -> StreamEvent:
        """记录 + 包装一段要往下游推的文本。"""
        nonlocal current_text
        current_text += piece
        return StreamEvent(type="stream_chunk", data={"text": piece})

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

        # 处理 reasoning 内容（OpenRouter / DeepSeek 等）：包进 <think>...</think>
        reasoning_piece = _extract_reasoning_delta(delta)
        if reasoning_piece:
            if not text_streaming_started:
                yield StreamEvent(type="stream_start")
                text_streaming_started = True
            if not thinking_open:
                yield _emit(_THINK_OPEN)
                thinking_open = True
            yield _emit(reasoning_piece)

        # 处理文本内容：逐 chunk 推送给下游
        if delta.content:
            if not text_streaming_started:
                yield StreamEvent(type="stream_start")
                text_streaming_started = True
            if thinking_open:
                # 思考结束、正式回答开始：先把 <think> 段闭合
                yield _emit(_THINK_CLOSE)
                thinking_open = False
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

            # 思考段没有自然闭合（纯 reasoning + tool_call，或模型只输出了 thinking）
            if thinking_open:
                yield _emit(_THINK_CLOSE)
                thinking_open = False

            if text_streaming_started:
                yield StreamEvent(type="stream_end")
                text_streaming_started = False

            yield _build_message(current_text, tool_calls_map, chunk, current_message_id)
            yielded = True

            current_text = ""
            tool_calls_map = {}
            current_message_id = str(uuid4())

    # 流结束后的 fallback：如果有未 yield 的内容（某些 API 可能不发送 finish_reason）
    if not yielded:
        if current_text or tool_calls_map:
            logger.warning(
                "流结束但未收到 finish_reason，fallback yield 已积累内容 (chunks={}, text_len={}, tool_calls={})",
                chunk_count,
                len(current_text),
                len(tool_calls_map),
            )
            if thinking_open:
                current_text += _THINK_CLOSE
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
