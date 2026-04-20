"""Stop Hook 调用包装

单一职责：在 agent loop 宣告完成前调用 stop hooks，并把任意异常降级为
"不阻塞继续" —— hook 故障绝不应该阻止主循环的正常推进。
"""

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message
from ripple.utils.logger import get_logger

logger = get_logger("core.stop_hooks")


async def handle_stop_hooks(
    messages: list[Message],
    assistant_messages: list[AssistantMessage],
    context: ToolUseContext,
):
    """执行 Stop Hooks；异常时退化为 no-op 结果"""
    from ripple.core.hooks import StopHookResult, execute_stop_hooks

    try:
        return await execute_stop_hooks(messages, assistant_messages, context)
    except Exception as e:
        logger.error("Stop Hook 执行异常（已忽略，不阻止继续）: {}", e)
        return StopHookResult(
            blocking_errors=[],
            prevent_continuation=False,
        )
