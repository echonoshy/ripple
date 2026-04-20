"""LLM 客户端抽象基类

定义统一的 provider 无关接口：
- `stream(messages, tools, model, ...)` → yield `AssistantMessage | StreamEvent`
- `complete(messages, model, ...)` → 返回 `{"text": str, "usage": {input_tokens, output_tokens}}`

各 provider 的 client（OpenRouter / Anthropic 等）在内部处理消息格式转换、工具格式转换
以及 streaming SSE 解析，对上层呈现统一语义。
"""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, AsyncGenerator

from ripple.messages.types import AssistantMessage, Message, StreamEvent

if TYPE_CHECKING:
    from ripple.tools.base import Tool


class LLMClient(ABC):
    """LLM 客户端基类

    所有 provider-specific 的 client 必须继承此类并实现 `stream`/`complete`。
    """

    # provider 类型标识："openai" 或 "anthropic"
    provider_type: str = "openai"

    # provider 实例名称（从配置读出，例如 "openrouter" / "wanjiedata"）
    provider_name: str = ""

    @abstractmethod
    async def stream(
        self,
        messages: list[Message | dict[str, Any]],
        tools: "list[Tool] | None" = None,
        model: str = "",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
        """流式调用模型

        Args:
            messages: Ripple 内部格式的消息列表（`Message` 对象或同构 dict）
            tools: `BaseTool` 列表
            model: 完整模型 ID
            max_tokens: 最大输出 token 数
            thinking: 是否启用思考模式
            **kwargs: 其他 provider 相关参数（temperature 等）

        Yields:
            `AssistantMessage`（一次完整回复）或 `StreamEvent`（文本流事件）
        """
        raise NotImplementedError
        # 让静态类型检查器认为这是 async generator
        yield  # type: ignore[unreachable]

    @abstractmethod
    async def complete(
        self,
        messages: list[Message | dict[str, Any]],
        model: str = "",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """非流式调用模型

        Args:
            messages: Ripple 内部格式的消息列表
            model: 完整模型 ID
            max_tokens: 最大输出 token 数
            thinking: 是否启用思考模式

        Returns:
            {"text": 纯文本回复, "usage": {"input_tokens", "output_tokens"}}
        """
        raise NotImplementedError
