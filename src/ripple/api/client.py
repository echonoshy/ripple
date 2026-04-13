"""OpenRouter API 客户端"""

from typing import Any, AsyncGenerator

import httpx
from openai import AsyncOpenAI

from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

logger = get_logger("api.client")


class OpenRouterClient:
    """OpenRouter API 客户端

    使用 OpenAI SDK 连接到 OpenRouter API。
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        """初始化客户端

        Args:
            api_key: OpenRouter API key，默认从配置文件读取
            base_url: API base URL，默认从配置文件读取
        """
        config = get_config()

        self.api_key = api_key or config.get("api.api_key")
        if not self.api_key:
            raise ValueError("API key is required. Please set 'api.api_key' in config/settings.yaml")

        self.base_url = base_url or config.get("api.base_url", "https://openrouter.ai/api/v1")

        # 检测是否是 LiteLLM
        self.is_litellm = "litellm" in self.base_url.lower()

        logger.info("初始化 API 客户端: base_url={}, is_litellm={}", self.base_url, self.is_litellm)

        self.client = AsyncOpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
            timeout=httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0),
            default_headers={
                "HTTP-Referer": "https://github.com/echonoshy/ripple",
                "X-Title": "Ripple Agent",
            },
        )

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str = "anthropic/claude-sonnet-4.6",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式调用聊天 API

        Args:
            messages: 消息列表
            tools: 工具定义列表
            model: 模型名称
            max_tokens: 最大输出 token 数
            thinking: 是否启用思考模式（None 则从配置读取）
            **kwargs: 其他参数

        Yields:
            流式响应块
        """
        config = get_config()
        if thinking is None:
            thinking = config.get("model.thinking.enabled", False)

        params = {
            "model": model,
            "messages": messages,
            "stream": True,
            **kwargs,
        }

        if thinking:
            params["extra_body"] = {
                "reasoning": {"enabled": True},
            }

        default_max_output = config.get("model.max_output_tokens", 60000)
        params["max_tokens"] = max_tokens or default_max_output

        if tools:
            params["tools"] = tools

        logger.debug(
            "stream_chat: model={}, messages={}, tools={}, thinking={}",
            model,
            len(messages),
            len(tools) if tools else 0,
            thinking,
        )

        stream = await self.client.chat.completions.create(**params)

        async for chunk in stream:
            yield chunk

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str = "anthropic/claude-sonnet-4.6",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs,
    ) -> dict[str, Any]:
        """非流式调用聊天 API

        Args:
            messages: 消息列表
            tools: 工具定义列表
            model: 模型名称
            max_tokens: 最大输出 token 数
            thinking: 是否启用思考模式（None 则从配置读取）
            **kwargs: 其他参数

        Returns:
            完整响应
        """
        config = get_config()
        if thinking is None:
            thinking = config.get("model.thinking.enabled", False)

        params = {
            "model": model,
            "messages": messages,
            "stream": False,
            **kwargs,
        }

        if thinking:
            params["extra_body"] = {
                "reasoning": {"enabled": True},
            }

        if tools:
            params["tools"] = tools

        default_max_output = config.get("model.max_output_tokens", 60000)
        params["max_tokens"] = max_tokens or default_max_output

        response = await self.client.chat.completions.create(**params)
        return response.model_dump()
