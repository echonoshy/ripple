"""OpenRouter API 客户端"""

from typing import Any, AsyncGenerator

from openai import AsyncOpenAI

from ripple.utils.config import get_config


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

        self.api_key = api_key or config.get("api.openrouter_api_key")
        if not self.api_key:
            raise ValueError(
                "OpenRouter API key is required. Please set 'api.openrouter_api_key' in config/settings.yaml"
            )

        self.base_url = base_url or config.get("api.base_url", "https://openrouter.ai/api/v1")

        # 检测是否是 LiteLLM
        self.is_litellm = "litellm" in self.base_url.lower()

        self.client = AsyncOpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
            default_headers={
                "HTTP-Referer": "https://github.com/echonoshy/ripple",
                "X-Title": "Ripple Agent",
            },
        )

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str = "anthropic/claude-3.5-sonnet",
        max_tokens: int | None = None,
        temperature: float = 1.0,
        **kwargs,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式调用聊天 API

        Args:
            messages: 消息列表
            tools: 工具定义列表
            model: 模型名称
            max_tokens: 最大输出 token 数
            temperature: 温度参数
            **kwargs: 其他参数

        Yields:
            流式响应块
        """
        params = {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": temperature,
            **kwargs,
        }

        if tools:
            params["tools"] = tools

        if max_tokens:
            params["max_tokens"] = max_tokens

        stream = await self.client.chat.completions.create(**params)

        async for chunk in stream:
            yield chunk

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str = "anthropic/claude-3.5-sonnet",
        max_tokens: int | None = None,
        temperature: float = 1.0,
        **kwargs,
    ) -> dict[str, Any]:
        """非流式调用聊天 API

        Args:
            messages: 消息列表
            tools: 工具定义列表
            model: 模型名称
            max_tokens: 最大输出 token 数
            temperature: 温度参数
            **kwargs: 其他参数

        Returns:
            完整响应
        """
        params = {
            "model": model,
            "messages": messages,
            "stream": False,
            "temperature": temperature,
            **kwargs,
        }

        if tools:
            params["tools"] = tools

        if max_tokens:
            params["max_tokens"] = max_tokens

        response = await self.client.chat.completions.create(**params)
        return response.model_dump()
