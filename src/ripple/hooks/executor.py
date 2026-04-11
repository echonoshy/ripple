"""Hook 执行器

实现 Stop Hooks 的执行逻辑。
"""

from dataclasses import dataclass

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage, Message, UserMessage


@dataclass
class StopHookResult:
    """Stop Hook 执行结果"""

    blocking_errors: list[UserMessage]
    prevent_continuation: bool


async def execute_stop_hooks(
    messages: list[Message],
    assistant_messages: list[AssistantMessage],
    context: ToolUseContext,
) -> StopHookResult:
    """执行 Stop Hooks

    Args:
        messages: 消息列表
        assistant_messages: 助手消息列表
        context: 工具使用上下文

    Returns:
        Stop Hook 结果
    """
    # TODO: 实现 Hook 执行逻辑
    # 目前返回空结果，表示没有 Hook 或所有 Hook 通过
    return StopHookResult(
        blocking_errors=[],
        prevent_continuation=False,
    )


async def execute_single_hook(
    hook: dict,
    messages: list[Message],
    context: ToolUseContext,
) -> dict:
    """执行单个 Hook

    Args:
        hook: Hook 配置
        messages: 消息列表
        context: 工具使用上下文

    Returns:
        Hook 执行结果
    """
    # TODO: 根据 hook 类型执行
    # - command: 执行 shell 命令
    # - prompt: 调用 LLM 评估
    # - agent: 运行子代理验证
    return {
        "outcome": "success",
        "blocking_error": None,
        "prevent_continuation": False,
    }
