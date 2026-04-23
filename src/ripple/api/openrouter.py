"""OpenRouter (OpenAI 兼容) API 客户端

把内部 Ripple 消息格式 → OpenAI Chat Completions 格式，
并把 OpenAI 流式响应反向解析回 `AssistantMessage` / `StreamEvent`。
"""

import time
from typing import TYPE_CHECKING, Any, AsyncGenerator

import httpx
from openai import AsyncOpenAI

from ripple.api.base import LLMClient, log_llm_call
from ripple.api.streaming import process_stream_response
from ripple.messages.types import AssistantMessage, Message, StreamEvent
from ripple.messages.utils import normalize_messages_for_api
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

if TYPE_CHECKING:
    from ripple.tools.base import Tool

logger = get_logger("api.openrouter")


class OpenRouterClient(LLMClient):
    """OpenRouter API 客户端（OpenAI 兼容）

    通过 AsyncOpenAI SDK 打 Chat Completions 端点，
    同时兼容任何使用 OpenAI 协议的第三方服务。
    """

    provider_type = "openai"

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        provider_name: str = "openrouter",
    ):
        config = get_config()

        if api_key is None or base_url is None:
            try:
                provider_cfg = config.get_provider_config(provider_name)
                api_key = api_key or provider_cfg.get("api_key")
                base_url = base_url or provider_cfg.get("base_url")
            except ValueError:
                # 兜底：用老式配置
                api_key = api_key or config.get("api.api_key")
                base_url = base_url or config.get("api.base_url", "https://openrouter.ai/api/v1")

        if not api_key:
            raise ValueError("OpenRouter API key 未配置，请在 config/settings.yaml 里设置")

        self.api_key = api_key
        self.base_url = base_url
        self.provider_name = provider_name

        logger.info("初始化 OpenRouter 客户端: base_url={}", self.base_url)

        # 从配置读取超时 / 重试参数（见 config/settings.yaml: api.timeout / api.max_retries）
        # - max_retries 只覆盖"流建立之前"的瞬时错误（APIConnectionError / 429 / 5xx）
        # - "流建立之后"的中断重试由 agent_loop 层兜底
        timeout_cfg = config.get("api.timeout", {}) or {}
        max_retries = config.get("api.max_retries", 3)

        self.client = AsyncOpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
            timeout=httpx.Timeout(
                connect=float(timeout_cfg.get("connect", 15.0)),
                read=float(timeout_cfg.get("read", 300.0)),
                write=float(timeout_cfg.get("write", 30.0)),
                pool=float(timeout_cfg.get("pool", 30.0)),
            ),
            max_retries=int(max_retries),
            default_headers={
                "HTTP-Referer": "https://github.com/echonoshy/ripple",
                "X-Title": "Ripple Agent",
            },
        )

    async def stream(
        self,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None" = None,
        model: str = "anthropic/claude-sonnet-4.6",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
        config = get_config()
        if thinking is None:
            thinking = config.get("model.thinking.enabled", False)

        api_messages = normalize_messages_for_api(messages)
        tool_schemas = [t.to_openai_tool() for t in tools] if tools else None

        params: dict[str, Any] = {
            "model": model,
            "messages": api_messages,
            "stream": True,
            **kwargs,
        }

        if thinking:
            params["extra_body"] = {"reasoning": {"enabled": True}}

        params["max_tokens"] = max_tokens or config.get("model.max_output_tokens", 60000)

        if tool_schemas:
            params["tools"] = tool_schemas

        tool_count = len(tool_schemas) if tool_schemas else 0
        logger.debug(
            "stream: model={}, messages={}, tools={}, thinking={}",
            model,
            len(api_messages),
            tool_count,
            thinking,
        )

        raw_stream = await self.client.chat.completions.create(**params)

        # 捕获 chunk 级元数据用于 llm_call 结构化日志（不解析 payload，只抓 id/usage/finish_reason）
        captured: dict[str, Any] = {
            "provider_request_id": None,
            "finish_reason": None,
            "prompt_tokens": 0,
            "completion_tokens": 0,
        }
        start_ts = time.monotonic()
        error_str: str | None = None

        async def _iter_and_capture() -> AsyncGenerator[Any, None]:
            async for chunk in raw_stream:
                if captured["provider_request_id"] is None:
                    chunk_id = getattr(chunk, "id", None)
                    if chunk_id:
                        captured["provider_request_id"] = chunk_id
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    captured["prompt_tokens"] = int(getattr(chunk_usage, "prompt_tokens", 0) or 0)
                    captured["completion_tokens"] = int(getattr(chunk_usage, "completion_tokens", 0) or 0)
                choices = getattr(chunk, "choices", None) or []
                if choices and getattr(choices[0], "finish_reason", None):
                    captured["finish_reason"] = choices[0].finish_reason
                yield chunk

        try:
            async for item in process_stream_response(_iter_and_capture()):
                yield item
        except Exception as e:
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
        model: str = "anthropic/claude-sonnet-4.6",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        config = get_config()
        if thinking is None:
            thinking = config.get("model.thinking.enabled", False)

        api_messages = normalize_messages_for_api(messages)

        params: dict[str, Any] = {
            "model": model,
            "messages": api_messages,
            "stream": False,
            **kwargs,
        }

        if thinking:
            params["extra_body"] = {"reasoning": {"enabled": True}}

        params["max_tokens"] = max_tokens or config.get("model.max_output_tokens", 60000)

        response = await self.client.chat.completions.create(**params)
        data = response.model_dump()

        choices = data.get("choices", [])
        text = ""
        if choices:
            text = choices[0].get("message", {}).get("content", "") or ""

        usage_raw = data.get("usage", {}) or {}
        usage = {
            "input_tokens": usage_raw.get("prompt_tokens", 0) or 0,
            "output_tokens": usage_raw.get("completion_tokens", 0) or 0,
        }

        return {"text": text, "usage": usage}
