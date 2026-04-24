"""Anthropic Messages API 兼容客户端

适用于：
- 万界（wjark / wanjiedata）的 `/api/anthropic` 端点
- 其他 Anthropic Messages API 兼容的第三方 provider
- （理论上）Anthropic 官方 API（本代码不使用官方 SDK，直接走 httpx）

对外暴露统一的 `stream()` / `complete()`，在内部：
- 消息：Ripple 内部格式 → Anthropic Messages API（system 抽出、content blocks 直通）
- 工具：BaseTool → `{"name","description","input_schema"}`
- 流式响应：SSE (message_start / content_block_delta / content_block_stop / message_delta / message_stop)
  → `AssistantMessage` / `StreamEvent`
"""

import json
import time
from typing import TYPE_CHECKING, Any, AsyncGenerator
from uuid import uuid4

import httpx

from ripple.api.base import LLMClient, log_llm_call
from ripple.messages.types import AssistantMessage, Message, StreamEvent
from ripple.messages.utils import create_assistant_message, normalize_messages_for_anthropic
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

if TYPE_CHECKING:
    from ripple.tools.base import Tool

logger = get_logger("api.anthropic")

# Anthropic API 版本标识；大多数第三方兼容服务都要求此 header
_ANTHROPIC_VERSION = "2023-06-01"

# 与 ripple.api.streaming 保持一致：把 thinking 内容包进 <think>...</think>，
# 共用 text 流交给前端 MarkdownRenderer 折叠渲染。
_THINK_OPEN = "<think>\n"
_THINK_CLOSE = "\n</think>\n\n"


class AnthropicClient(LLMClient):
    """Anthropic Messages API 兼容客户端"""

    provider_type = "anthropic"

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        provider_name: str = "wanjiedata",
    ):
        config = get_config()

        if api_key is None or base_url is None:
            provider_cfg = config.get_provider_config(provider_name)
            api_key = api_key or provider_cfg.get("api_key")
            base_url = base_url or provider_cfg.get("base_url")

        if not api_key:
            raise ValueError(f"Provider '{provider_name}' 缺少 api_key，请检查 config/settings.yaml")
        if not base_url:
            raise ValueError(f"Provider '{provider_name}' 缺少 base_url，请检查 config/settings.yaml")

        self.api_key: str = api_key
        self.base_url: str = base_url.rstrip("/")
        self.provider_name = provider_name

        logger.info("初始化 Anthropic 客户端: base_url={}", self.base_url)

        # 兼容两种鉴权：标准 Anthropic 用 x-api-key，其他第三方多用 Authorization: Bearer。
        # 同时发，服务端自取所需。
        self._headers = {
            "x-api-key": self.api_key,
            "Authorization": f"Bearer {self.api_key}",
            "anthropic-version": _ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

        self._timeout = httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)

    def _build_payload(
        self,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None",
        model: str,
        max_tokens: int,
        thinking: bool,
        stream: bool,
        extra: dict[str, Any],
    ) -> dict[str, Any]:
        """构建 Anthropic Messages API 请求体"""
        system_prompt, api_messages = normalize_messages_for_anthropic(messages)

        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": api_messages,
            "stream": stream,
        }

        if system_prompt:
            payload["system"] = system_prompt

        if tools:
            payload["tools"] = [t.to_anthropic_tool() for t in tools]

        # Anthropic 扩展思考模式（thinking）；非官方端点可能不支持，不开默认不加字段。
        if thinking:
            # Anthropic 官方格式：{"thinking": {"type": "enabled", "budget_tokens": N}}
            payload["thinking"] = {"type": "enabled", "budget_tokens": min(max_tokens // 2, 16000)}

        # 透传其他参数（temperature 等）
        for k, v in extra.items():
            if k in payload:
                continue
            payload[k] = v

        return payload

    async def stream(
        self,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None" = None,
        model: str = "claude-sonnet-4-6",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
        config = get_config()
        if thinking is None:
            thinking = bool(config.get("model.thinking.enabled", False))
        resolved_max = max_tokens or config.get("model.max_output_tokens", 60000)

        payload = self._build_payload(
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=resolved_max,
            thinking=thinking,
            stream=True,
            extra=kwargs,
        )

        tool_count = len(payload.get("tools", []) or [])
        logger.debug(
            "stream: model={}, messages={}, tools={}, thinking={}",
            model,
            len(payload.get("messages", [])),
            tool_count,
            thinking,
        )

        url = f"{self.base_url}/v1/messages"

        start_ts = time.monotonic()
        captured: dict[str, Any] = {
            "provider_request_id": None,
            "finish_reason": None,
            "prompt_tokens": 0,
            "completion_tokens": 0,
        }
        error_str: str | None = None

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                async with client.stream("POST", url, headers=self._headers, json=payload) as response:
                    if response.status_code >= 400:
                        err_body = await response.aread()
                        text = err_body.decode("utf-8", errors="replace")
                        logger.error("Anthropic API 错误: status={}, body={}", response.status_code, text[:500])
                        error_str = f"http {response.status_code}"
                        raise RuntimeError(f"Anthropic API error {response.status_code}: {text}")

                    async for item in _parse_anthropic_sse(response.aiter_lines(), captured=captured):
                        yield item
        except Exception as e:
            if error_str is None:
                error_str = str(e)
            raise
        finally:
            log_llm_call(
                provider=self.provider_name,
                model=model,
                prompt_tokens=captured["prompt_tokens"],
                completion_tokens=captured["completion_tokens"],
                duration_ms=(time.monotonic() - start_ts) * 1000.0,
                finish_reason=captured["finish_reason"],
                provider_request_id=captured["provider_request_id"],
                tool_count=tool_count,
                error=error_str,
            )

    async def complete(
        self,
        messages: list[Message | dict[str, Any]],
        model: str = "claude-sonnet-4-6",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        config = get_config()
        if thinking is None:
            thinking = bool(config.get("model.thinking.enabled", False))
        resolved_max = max_tokens or config.get("model.max_output_tokens", 60000)

        payload = self._build_payload(
            messages=messages,
            tools=None,
            model=model,
            max_tokens=resolved_max,
            thinking=thinking,
            stream=False,
            extra=kwargs,
        )

        url = f"{self.base_url}/v1/messages"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(url, headers=self._headers, json=payload)
            if response.status_code >= 400:
                logger.error("Anthropic API 错误: status={}, body={}", response.status_code, response.text[:500])
                raise RuntimeError(f"Anthropic API error {response.status_code}: {response.text}")
            data = response.json()

        text_parts: list[str] = []
        for block in data.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", "") or "")

        usage_raw = data.get("usage", {}) or {}
        usage = {
            "input_tokens": usage_raw.get("input_tokens", 0) or 0,
            "output_tokens": usage_raw.get("output_tokens", 0) or 0,
        }

        return {"text": "".join(text_parts), "usage": usage}


# ---------- Anthropic SSE 解析 ----------


async def _parse_anthropic_sse(
    lines_iter: AsyncGenerator[str, None],
    captured: dict[str, Any] | None = None,
) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
    """解析 Anthropic Messages API 的 SSE 流，yield 统一的内部事件

    事件序列：
      message_start
      (content_block_start content_block_delta* content_block_stop)*
      message_delta
      message_stop

    对应输出：
      stream_start → stream_chunk* → stream_end → AssistantMessage

    Args:
        lines_iter: SSE 字节流按行迭代器
        captured: 可选的元数据收集 dict，会就地写入 provider_request_id /
            prompt_tokens / completion_tokens / finish_reason，供调用方打 llm_call 日志

    注意：text 和 tool_use 可能交替出现，需要按 index 维护各 content block 的累积状态。
    """
    current_message_id: str = str(uuid4())
    # index -> {"type":"text"|"tool_use"|"thinking", "text":"", "id":"", "name":"", "args_buffer":""}
    block_states: dict[int, dict[str, Any]] = {}

    # 汇总 usage（message_start 带 input_tokens，message_delta 带 output_tokens）
    usage: dict[str, int] = {}

    text_streaming_started = False
    thinking_open = False  # 当前是否处在 <think>...</think> 段中
    yielded_message = False

    async for raw_line in lines_iter:
        if not raw_line:
            continue
        # SSE 每条事件由 "event: xxx" 和 "data: {...}" 组成；我们只用 data 行里带 type 字段做分派
        if raw_line.startswith("event:"):
            continue
        if not raw_line.startswith("data:"):
            continue

        data_str = raw_line[5:].strip()
        if not data_str or data_str == "[DONE]":
            continue

        try:
            event = json.loads(data_str)
        except json.JSONDecodeError:
            logger.warning("Anthropic SSE 非法 JSON: {}", data_str[:200])
            continue

        etype = event.get("type")

        if etype == "message_start":
            message = event.get("message", {}) or {}
            current_message_id = message.get("id") or str(uuid4())
            msg_usage = message.get("usage", {}) or {}
            if msg_usage.get("input_tokens") is not None:
                usage["input_tokens"] = msg_usage["input_tokens"]
            if captured is not None:
                if captured.get("provider_request_id") is None and message.get("id"):
                    captured["provider_request_id"] = message["id"]
                if msg_usage.get("input_tokens") is not None:
                    captured["prompt_tokens"] = int(msg_usage["input_tokens"] or 0)

        elif etype == "content_block_start":
            index = event.get("index", 0)
            block = event.get("content_block", {}) or {}
            btype = block.get("type")

            if btype == "text":
                # 切到正式文本：若上一段 thinking 还未闭合，先收尾
                if thinking_open:
                    yield StreamEvent(type="stream_chunk", data={"text": _THINK_CLOSE})
                    _append_to_text_block(block_states, _THINK_CLOSE)
                    thinking_open = False
                block_states[index] = {"type": "text", "text": ""}
            elif btype == "tool_use":
                if thinking_open:
                    yield StreamEvent(type="stream_chunk", data={"text": _THINK_CLOSE})
                    _append_to_text_block(block_states, _THINK_CLOSE)
                    thinking_open = False
                block_states[index] = {
                    "type": "tool_use",
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "args_buffer": "",
                }
            elif btype == "thinking":
                # Anthropic extended thinking：累积到本 block 的 text 字段，
                # build_assistant_message 时合并进上一个 / 新建 text block 一起持久化
                block_states[index] = {"type": "thinking", "text": ""}
            else:
                block_states[index] = {"type": btype or "unknown"}

        elif etype == "content_block_delta":
            index = event.get("index", 0)
            delta = event.get("delta", {}) or {}
            dtype = delta.get("type")
            state = block_states.get(index)
            if state is None:
                continue

            if dtype == "text_delta":
                text_piece = delta.get("text", "") or ""
                state["text"] = state.get("text", "") + text_piece
                if not text_streaming_started:
                    yield StreamEvent(type="stream_start")
                    text_streaming_started = True
                if text_piece:
                    yield StreamEvent(type="stream_chunk", data={"text": text_piece})

            elif dtype == "input_json_delta":
                state["args_buffer"] = state.get("args_buffer", "") + (delta.get("partial_json", "") or "")

            elif dtype == "thinking_delta":
                think_piece = delta.get("thinking", "") or ""
                state["text"] = state.get("text", "") + think_piece
                if not text_streaming_started:
                    yield StreamEvent(type="stream_start")
                    text_streaming_started = True
                if not thinking_open:
                    yield StreamEvent(type="stream_chunk", data={"text": _THINK_OPEN})
                    thinking_open = True
                if think_piece:
                    yield StreamEvent(type="stream_chunk", data={"text": think_piece})

            # signature_delta 等暂不处理（thinking 接力需要时再补）

        elif etype == "content_block_stop":
            # 到这里该 block 已收齐；无需特殊处理，统一在 message_stop 时汇总
            pass

        elif etype == "message_delta":
            msg_delta_usage = event.get("usage", {}) or {}
            if msg_delta_usage.get("output_tokens") is not None:
                usage["output_tokens"] = msg_delta_usage["output_tokens"]
            # Anthropic 的 stop_reason 放在 message_delta.delta 里
            delta_meta = event.get("delta", {}) or {}
            if captured is not None:
                if msg_delta_usage.get("output_tokens") is not None:
                    captured["completion_tokens"] = int(msg_delta_usage["output_tokens"] or 0)
                if delta_meta.get("stop_reason"):
                    captured["finish_reason"] = delta_meta["stop_reason"]

        elif etype == "message_stop":
            # 收尾未闭合的 <think> 段（极少：纯 thinking 没有任何后续 content）
            if thinking_open:
                yield StreamEvent(type="stream_chunk", data={"text": _THINK_CLOSE})
                thinking_open = False

            if text_streaming_started:
                yield StreamEvent(type="stream_end")
                text_streaming_started = False

            yield _build_assistant_message(current_message_id, block_states, usage)
            yielded_message = True

            # 重置状态准备下一个 message（多数情况不会有第二个 message）
            block_states = {}
            usage = {}
            current_message_id = str(uuid4())

        elif etype == "error":
            err = event.get("error", {}) or {}
            raise RuntimeError(f"Anthropic SSE error: {err}")

        # 其他事件（ping 等）忽略

    # 流结束但没有收到 message_stop — 做 fallback
    if not yielded_message and block_states:
        if thinking_open:
            yield StreamEvent(type="stream_chunk", data={"text": _THINK_CLOSE})
        if text_streaming_started:
            yield StreamEvent(type="stream_end")
        logger.warning("Anthropic 流结束但未收到 message_stop，fallback yield 内容 (blocks={})", len(block_states))
        yield _build_assistant_message(current_message_id, block_states, usage)


def _append_to_text_block(block_states: dict[int, dict[str, Any]], piece: str) -> None:
    """把一段文本追加到当前最后一个 text block，让持久化里的 text 与流出的内容一致。

    用于 thinking 段闭合时把 </think> 写入持久化结构。
    """
    for index in sorted(block_states.keys(), reverse=True):
        state = block_states[index]
        if state.get("type") == "text":
            state["text"] = state.get("text", "") + piece
            return
    # 没有 text block 就新开一个（极少见：thinking 后立即 tool_use）
    new_index = (max(block_states.keys()) + 1) if block_states else 0
    block_states[new_index] = {"type": "text", "text": piece}


def _build_assistant_message(
    message_id: str,
    block_states: dict[int, dict[str, Any]],
    usage: dict[str, int],
) -> AssistantMessage:
    """把累积的 block_states 按 index 顺序组装为 AssistantMessage

    thinking block 会被包成 <think>...</think> 合并进相邻的 text block，让
    messages.jsonl 里直接保留可被前端 MarkdownRenderer 渲染的文本结构，无须
    新增 thinking content block 类型。
    """
    content: list[dict[str, Any]] = []

    for index in sorted(block_states.keys()):
        state = block_states[index]
        btype = state.get("type")

        if btype == "text":
            text = state.get("text", "") or ""
            if text:
                content.append({"type": "text", "text": text})

        elif btype == "thinking":
            think_text = state.get("text", "") or ""
            if not think_text:
                continue
            wrapped = f"{_THINK_OPEN}{think_text}{_THINK_CLOSE}"
            # 与下一个相邻 text block 合并；若没有，则单独成块
            if content and content[-1].get("type") == "text":
                content[-1]["text"] = wrapped + content[-1]["text"]
            else:
                content.append({"type": "text", "text": wrapped})

        elif btype == "tool_use":
            args_buffer = state.get("args_buffer", "") or ""
            tool_input: dict[str, Any] = {}
            parse_error = False
            if args_buffer:
                try:
                    parsed = json.loads(args_buffer)
                    if isinstance(parsed, dict):
                        tool_input = parsed
                    else:
                        parse_error = True
                except json.JSONDecodeError:
                    parse_error = True
                    logger.warning(
                        "Anthropic tool_use 参数 JSON 解析失败: name={}, raw={}",
                        state.get("name"),
                        args_buffer[:200],
                    )

            tool_id = state.get("id") or str(uuid4())
            block: dict[str, Any] = {
                "type": "tool_use",
                "id": tool_id,
                "name": state.get("name", ""),
                "input": tool_input,
            }
            if parse_error:
                block["_args_parse_error"] = args_buffer[:200]
            content.append(block)

        # 其他类型的 block（thinking 等）暂时丢弃，避免污染内部消息结构

    return create_assistant_message(content=content, message_id=message_id, usage=usage)
