"""LLM 客户端统一入口

为了兼容历史代码，这里重新导出：
- `LLMClient`：所有 client 的抽象基类
- `OpenRouterClient`：OpenAI 兼容 provider 的 client（旧默认）
- `AnthropicClient`：Anthropic Messages API 兼容 provider 的 client（万界/wjark 等）
- `create_client()`：工厂函数，按配置自动选择

推荐新代码使用 `create_client()`；直接实例化 `OpenRouterClient()` 的老用法依然工作，
默认会走 `api.providers.openrouter`（或老式 `api.api_key`/`api.base_url`）。
"""

from ripple.api.anthropic import AnthropicClient
from ripple.api.base import LLMClient
from ripple.api.factory import create_client
from ripple.api.openrouter import OpenRouterClient

__all__ = ["LLMClient", "OpenRouterClient", "AnthropicClient", "create_client"]
