"""Hook 执行器

Stop Hook 原语实现。`core.stop_hooks.handle_stop_hooks` 是 agent loop 的
resilient 包装层，会把此处抛出的异常降级为 no-op；底层调用方应调用
`execute_stop_hooks` 获取原始结果。
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

    目前为占位实现：返回"无 hook / 全部通过"。后续接入 hook 调度时替换此逻辑。
    """
    # TODO: 实现 Hook 执行逻辑
    return StopHookResult(
        blocking_errors=[],
        prevent_continuation=False,
    )


async def execute_single_hook(
    hook: dict,
    messages: list[Message],
    context: ToolUseContext,
) -> dict:
    """执行单个 Hook（按 hook 类型分派）

    TODO: 根据 hook 类型执行
      - command: 执行 shell 命令
      - prompt:  调用 LLM 评估
      - agent:   运行子代理验证
    """
    return {
        "outcome": "success",
        "blocking_error": None,
        "prevent_continuation": False,
    }
