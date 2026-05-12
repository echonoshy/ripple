"""OpenAI Codex Responses client.

This provider is intentionally isolated from the existing Anthropic Messages
client. It speaks the Codex Responses transport and converts only at the
LLMClient boundary back into Ripple's internal message blocks.
"""

import json
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncGenerator
from uuid import uuid4

import httpx

from ripple.api.base import LLMClient, log_llm_call
from ripple.messages.types import AssistantMessage, Message, StreamEvent
from ripple.messages.utils import create_assistant_message, deserialize_message
from ripple.sandbox.openai_codex import read_credentials_file, refresh_credentials, write_credentials_file
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

if TYPE_CHECKING:
    from ripple.tools.base import Tool

logger = get_logger("api.openai_codex")

DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
CODEX_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}
CODEX_UNSUPPORTED_PARAMETERS = {
    "max_output_tokens",
    "temperature",
    "top_p",
    "parallel_tool_calls",
}


class OpenAICodexClient(LLMClient):
    """ChatGPT/Codex subscription-backed Responses client."""

    provider_type = "openai-codex-responses"

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        provider_name: str = "openai-codex",
        credentials_file: Path | None = None,
    ):
        config = get_config()
        try:
            provider_cfg = config.get_provider_config(provider_name)
        except ValueError:
            provider_cfg = {}
        self.api_key = api_key or provider_cfg.get("api_key")
        self.base_url = (base_url or provider_cfg.get("base_url") or DEFAULT_CODEX_BASE_URL).rstrip("/")
        self.provider_name = provider_name
        self.credentials_file = credentials_file

        timeout_cfg = config.get("api.timeout", {}) or {}
        self._timeout = httpx.Timeout(
            connect=float(timeout_cfg.get("connect", 15.0)),
            read=float(timeout_cfg.get("read", 300.0)),
            write=float(timeout_cfg.get("write", 30.0)),
            pool=float(timeout_cfg.get("pool", 30.0)),
        )

    async def _access_token(self) -> str:
        if self.api_key:
            return self.api_key
        if self.credentials_file:
            credentials = read_credentials_file(self.credentials_file)
            if credentials:
                if credentials.expires > int(time.time() * 1000) + 60_000:
                    return credentials.access
                refreshed = await refresh_credentials(credentials)
                write_credentials_file(self.credentials_file, refreshed)
                return refreshed.access
        raise ValueError("OpenAI Codex 尚未登录。请先完成 ChatGPT/Codex 订阅账号授权。")

    async def access_token_for_test(self) -> str:
        return await self._access_token()

    def _build_payload(
        self,
        *,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None",
        model: str,
        max_tokens: int,
        reasoning_effort: str | None,
        stream: bool,
        extra: dict[str, Any],
    ) -> dict[str, Any]:
        instructions, input_items = _normalize_messages_for_responses(messages)
        payload: dict[str, Any] = {
            "model": model,
            "input": input_items,
            "stream": stream,
            "store": False,
        }
        if instructions:
            payload["instructions"] = instructions
        if reasoning_effort:
            effort = reasoning_effort.strip().lower()
            if effort not in CODEX_REASONING_EFFORTS:
                allowed = ", ".join(sorted(CODEX_REASONING_EFFORTS))
                raise ValueError(f"未知 OpenAI Codex reasoning_effort: {reasoning_effort!r}，可选值: {allowed}")
            payload["reasoning"] = {"effort": effort}
            payload["include"] = ["reasoning.encrypted_content"]
        if tools:
            payload["tools"] = [_tool_to_responses_function(tool) for tool in tools]
        for key, value in extra.items():
            if key in CODEX_UNSUPPORTED_PARAMETERS:
                continue
            if key not in payload:
                payload[key] = value
        return payload

    def build_payload_for_test(
        self,
        *,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None",
        model: str,
        max_tokens: int,
        reasoning_effort: str | None,
        stream: bool,
        extra: dict[str, Any],
    ) -> dict[str, Any]:
        return self._build_payload(
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            stream=stream,
            extra=extra,
        )

    async def stream(
        self,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None" = None,
        model: str = "gpt-5.5",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
        config = get_config()
        resolved_max = max_tokens or config.get("model.max_output_tokens", 60000)
        reasoning_effort = kwargs.pop("reasoning_effort", None)
        if reasoning_effort is None and thinking:
            reasoning_effort = "medium"

        payload = self._build_payload(
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=resolved_max,
            reasoning_effort=reasoning_effort,
            stream=True,
            extra=kwargs,
        )
        headers = {
            "Authorization": f"Bearer {await self._access_token()}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        url = f"{self.base_url}/responses"

        captured: dict[str, Any] = {
            "provider_request_id": None,
            "finish_reason": None,
            "prompt_tokens": 0,
            "completion_tokens": 0,
        }
        start_ts = time.monotonic()
        error_str: str | None = None

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as response:
                    if response.status_code >= 400:
                        text = (await response.aread()).decode("utf-8", errors="replace")
                        error_str = f"http {response.status_code}"
                        raise RuntimeError(f"OpenAI Codex API error {response.status_code}: {text}")
                    async for item in parse_codex_sse_lines(response.aiter_lines(), captured=captured):
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
                tool_count=len(tools or []),
                error=error_str,
            )

    async def complete(
        self,
        messages: list[Message | dict[str, Any]],
        model: str = "gpt-5.5",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        config = get_config()
        resolved_max = max_tokens or config.get("model.max_output_tokens", 60000)
        reasoning_effort = kwargs.pop("reasoning_effort", None)
        if reasoning_effort is None and thinking:
            reasoning_effort = "medium"
        payload = self._build_payload(
            messages=messages,
            tools=None,
            model=model,
            max_tokens=resolved_max,
            reasoning_effort=reasoning_effort,
            stream=False,
            extra=kwargs,
        )
        headers = {
            "Authorization": f"Bearer {await self._access_token()}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(f"{self.base_url}/responses", headers=headers, json=payload)
            if response.status_code >= 400:
                raise RuntimeError(f"OpenAI Codex API error {response.status_code}: {response.text}")
            data = response.json()
        text = _extract_response_text(data)
        usage_raw = data.get("usage", {}) or {}
        return {
            "text": text,
            "usage": {
                "input_tokens": usage_raw.get("input_tokens", 0) or 0,
                "output_tokens": usage_raw.get("output_tokens", 0) or 0,
            },
        }


async def parse_codex_sse_lines(
    lines_iter: AsyncGenerator[str, None],
    captured: dict[str, Any] | None = None,
) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
    response_id = str(uuid4())
    text_parts: list[str] = []
    tool_blocks: list[dict[str, Any]] = []
    usage: dict[str, int] = {}
    text_started = False
    completed = False

    async for line in lines_iter:
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        data_str = line.removeprefix("data:").strip()
        if data_str == "[DONE]":
            break
        try:
            event = json.loads(data_str)
        except json.JSONDecodeError:
            logger.warning("OpenAI Codex SSE 非法 JSON: {}", data_str[:200])
            continue
        if not isinstance(event, dict):
            continue

        etype = event.get("type")
        if etype == "response.created":
            response = event.get("response") if isinstance(event.get("response"), dict) else {}
            response_id = str(response.get("id") or response_id)
            if captured is not None:
                captured["provider_request_id"] = response_id
            continue

        if etype == "response.output_text.delta":
            delta = event.get("delta")
            if not isinstance(delta, str) or not delta:
                continue
            if not text_started:
                yield StreamEvent(type="stream_start")
                text_started = True
            text_parts.append(delta)
            yield StreamEvent(type="stream_chunk", data={"text": delta})
            continue

        if etype == "response.output_item.done":
            block = _tool_block_from_output_item(event.get("item"))
            if block:
                tool_blocks.append(block)
            continue

        if etype in {"response.completed", "response.failed", "response.incomplete"}:
            response = event.get("response") if isinstance(event.get("response"), dict) else {}
            response_id = str(response.get("id") or response_id)
            usage = _usage_from_response(response)
            if captured is not None:
                captured["provider_request_id"] = response_id
                captured["finish_reason"] = etype.removeprefix("response.")
                captured["prompt_tokens"] = usage.get("input_tokens", 0)
                captured["completion_tokens"] = usage.get("output_tokens", 0)
            if text_started:
                yield StreamEvent(type="stream_end")
            yield create_assistant_message(
                content=_content_blocks("".join(text_parts), tool_blocks),
                message_id=response_id,
                usage=usage,
            )
            completed = True
            break

    if not completed and (text_parts or tool_blocks):
        if text_started:
            yield StreamEvent(type="stream_end")
        yield create_assistant_message(
            content=_content_blocks("".join(text_parts), tool_blocks),
            message_id=response_id,
            usage=usage,
        )


def _normalize_messages_for_responses(
    messages: list[Message | dict[str, Any]],
) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts: list[str] = []
    items: list[dict[str, Any]] = []
    for msg in messages:
        if isinstance(msg, dict):
            if "role" in msg and "type" not in msg:
                system_text, raw_items = _raw_role_message_to_responses(msg)
                if system_text:
                    system_parts.append(system_text)
                items.extend(raw_items)
                continue
            msg = deserialize_message(msg)
            if isinstance(msg, dict):
                continue

        if msg.type == "user" and msg.is_meta:
            continue
        if msg.type == "system":
            if msg.content.strip():
                system_parts.append(msg.content)
            continue
        if msg.type in ("progress", "attachment"):
            continue
        if msg.type == "user":
            items.extend(_user_content_to_responses(msg.message.get("content", [])))
            continue
        if msg.type == "assistant":
            items.extend(_assistant_content_to_responses(msg.message.get("content", [])))
            continue
    instructions = "\n\n".join(system_parts) if system_parts else None
    return instructions, items


def _raw_role_message_to_responses(msg: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    role = msg.get("role")
    content = msg.get("content")
    if role == "tool":
        return None, [
            {
                "type": "function_call_output",
                "call_id": msg.get("tool_call_id", ""),
                "output": content or "",
            }
        ]
    if role not in {"system", "user", "assistant"}:
        return None, []
    if role == "system":
        text = content if isinstance(content, str) else _text_from_blocks(content)
        return (text if text.strip() else None), []
    if isinstance(content, str):
        return None, [_message_item(role, [{"type": "input_text", "text": content}])]
    if isinstance(content, list):
        text = _text_from_blocks(content)
        return None, [_message_item(role, [{"type": "input_text", "text": text}])] if text else []
    return None, []


def _user_content_to_responses(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    text_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text_parts.append(block.get("text", "") or "")
        elif block.get("type") == "tool_result":
            out.append(
                {
                    "type": "function_call_output",
                    "call_id": block.get("tool_use_id", ""),
                    "output": block.get("content", "") or "",
                }
            )
    if text_parts:
        out.insert(0, _message_item("user", [{"type": "input_text", "text": "".join(text_parts)}]))
    return out


def _assistant_content_to_responses(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    text = _text_from_blocks(content)
    if text:
        out.append(_message_item("assistant", [{"type": "output_text", "text": text}]))
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            out.append(
                {
                    "type": "function_call",
                    "call_id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "arguments": json.dumps(block.get("input", {}) or {}, ensure_ascii=False),
                }
            )
    return out


def _message_item(role: str, content: list[dict[str, str]]) -> dict[str, Any]:
    return {"role": role, "content": content}


def _text_from_blocks(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", "") or "")
    return "".join(parts)


def _tool_to_responses_function(tool: "Tool") -> dict[str, Any]:
    schema = tool.to_openai_tool()
    function = schema.get("function", {}) if isinstance(schema, dict) else {}
    return {
        "type": "function",
        "name": function.get("name", ""),
        "description": function.get("description", ""),
        "parameters": function.get("parameters", {"type": "object", "properties": {}}),
    }


def _tool_block_from_output_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict) or item.get("type") != "function_call":
        return None
    raw_args = item.get("arguments", "")
    parsed_args: dict[str, Any] = {}
    if isinstance(raw_args, str) and raw_args.strip():
        try:
            parsed = json.loads(raw_args)
            if isinstance(parsed, dict):
                parsed_args = parsed
        except json.JSONDecodeError:
            logger.warning("OpenAI Codex tool arguments JSON 解析失败: {}", raw_args[:200])
    return {
        "type": "tool_use",
        "id": item.get("call_id") or item.get("id") or str(uuid4()),
        "name": item.get("name", ""),
        "input": parsed_args,
    }


def _usage_from_response(response: dict[str, Any]) -> dict[str, int]:
    usage_raw = response.get("usage", {}) or {}
    if not isinstance(usage_raw, dict):
        return {}
    return {
        "input_tokens": int(usage_raw.get("input_tokens", 0) or 0),
        "output_tokens": int(usage_raw.get("output_tokens", 0) or 0),
    }


def _content_blocks(text: str, tool_blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    if text:
        content.append({"type": "text", "text": text})
    content.extend(tool_blocks)
    return content


def _extract_response_text(data: dict[str, Any]) -> str:
    output = data.get("output", [])
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") in {"output_text", "text"}:
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
    return "".join(parts)
