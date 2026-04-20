"""LLM 客户端工厂

根据配置文件 `api.provider` 选择合适的 client 实现。
"""

from ripple.api.anthropic import AnthropicClient
from ripple.api.base import LLMClient
from ripple.api.openrouter import OpenRouterClient
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

logger = get_logger("api.factory")


def create_client(provider: str | None = None) -> LLMClient:
    """创建 LLM 客户端

    Args:
        provider: 可选的 provider 名称（例如 "openrouter" / "wanjiedata"）；
                  None 表示使用配置里 `api.provider` 指定的默认值。

    Returns:
        对应的 LLMClient 实例
    """
    config = get_config()

    if provider is None:
        provider = config.get_current_provider()

    provider_cfg = config.get_provider_config(provider)
    ptype = (provider_cfg.get("type") or "openai").lower()

    logger.info("创建 LLM 客户端: provider={}, type={}", provider, ptype)

    if ptype == "anthropic":
        return AnthropicClient(provider_name=provider)
    if ptype == "openai":
        return OpenRouterClient(provider_name=provider)

    raise ValueError(f"未知的 provider type: {ptype}（provider={provider}）")
