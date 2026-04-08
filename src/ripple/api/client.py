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

        self.api_key = api_key or config.get("api.api_key")
        if not self.api_key:
            raise ValueError("API key is required. Please set 'api.api_key' in config/settings.yaml")

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
        thinking: bool | None = None,
        thinking_budget: int | None = None,
        **kwargs,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式调用聊天 API

        Args:
            messages: 消息列表
            tools: 工具定义列表
            model: 模型名称
            max_tokens: 最大输出 token 数
            temperature: 温度参数
            thinking: 是否启用思考模式（None 则从配置读取）
            thinking_budget: 思考预算 token 数
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
            if thinking_budget is None:
                thinking_budget = config.get("model.thinking.budget_tokens", 10000)
            params["extra_body"] = {
                "thinking": {"type": "enabled", "budget_tokens": thinking_budget},
            }
            # 思考模式下 temperature 必须为 1，且需要设置 max_tokens
            params["temperature"] = 1.0
            params["max_tokens"] = max_tokens or 16000
        else:
            params["temperature"] = temperature
            if max_tokens:
                params["max_tokens"] = max_tokens

        if tools:
            params["tools"] = tools

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
