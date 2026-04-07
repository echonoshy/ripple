"""OpenRouter API 客户端"""

import os
from typing import Any, AsyncGenerator, Dict, List

from openai import AsyncOpenAI


class OpenRouterClient:
    """OpenRouter API 客户端

    使用 OpenAI SDK 连接到 OpenRouter API。
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        """初始化客户端

        Args:
            api_key: OpenRouter API key，默认从环境变量 OPENROUTER_API_KEY 读取
            base_url: API base URL，默认为 OpenRouter 官方地址
        """
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError("OpenRouter API key is required. Set OPENROUTER_API_KEY environment variable.")

        self.base_url = base_url or "https://openrouter.ai/api/v1"
        self.client = AsyncOpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
        )

    async def stream_chat(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]] | None = None,
        model: str = "anthropic/claude-3.5-sonnet",
        max_tokens: int | None = None,
        temperature: float = 1.0,
        **kwargs,
    ) -> AsyncGenerator[Dict[str, Any], None]:
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
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]] | None = None,
        model: str = "anthropic/claude-3.5-sonnet",
        max_tokens: int | None = None,
        temperature: float = 1.0,
        **kwargs,
    ) -> Dict[str, Any]:
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
