"""附件系统 — 向模型注入上下文提醒

参考 Claude Code 的 todo_reminder / task_reminder 机制，
在模型长时间未使用 Task 工具时自动注入提醒。
"""

from ripple.messages.types import Message, UserMessage
from ripple.messages.utils import create_user_message
from ripple.utils.logger import get_logger

logger = get_logger("utils.attachments")

TASK_TOOL_NAMES = {"TaskCreate", "TaskUpdate"}

TASK_REMINDER_CONFIG = {
    "TURNS_SINCE_WRITE": 10,
    "TURNS_BETWEEN_REMINDERS": 10,
}


def _count_assistant_turns_since_task_tool(messages: list[Message]) -> int:
    """从末尾往前数，距离最近一次 TaskCreate/TaskUpdate 调用过了多少个 assistant 轮次"""
    count = 0
    for msg in reversed(messages):
        if msg.type == "assistant":
            content = msg.message.get("content", [])
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    if block.get("name") in TASK_TOOL_NAMES:
                        return count
            count += 1
    return count


def _count_assistant_turns_since_last_reminder(messages: list[Message]) -> int:
    """从末尾往前数，距离最近一次 task_reminder 附件过了多少个 assistant 轮次"""
    count = 0
    for msg in reversed(messages):
        if msg.type == "user":
            content = msg.message.get("content", [])
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    if "task tools haven't been used" in block.get("text", ""):
                        return count
        if msg.type == "assistant":
            count += 1
    return count


def _get_current_task_list_text(cwd) -> str | None:
    """读取当前任务列表并格式化为文本"""
    from ripple.tasks.manager import get_task_manager

    try:
        task_manager = get_task_manager(cwd / ".ripple" / "tasks.json")
        tasks = task_manager.list_tasks(include_deleted=False)
        if not tasks:
            return None

        lines = []
        for task in tasks:
            lines.append(f"#{task.id}. [{task.status.value}] {task.subject}")
        return "\n".join(lines)
    except Exception:
        return None


def get_task_reminder_attachment(
    messages: list[Message],
    cwd,
) -> UserMessage | None:
    """检查是否需要向模型注入 task_reminder 附件

    条件（参考 Claude Code）:
    1. 最近 N 轮 assistant 消息中没有使用 TaskCreate/TaskUpdate
    2. 距离上次 reminder 至少 N 轮
    """
    turns_since_tool = _count_assistant_turns_since_task_tool(messages)
    if turns_since_tool < TASK_REMINDER_CONFIG["TURNS_SINCE_WRITE"]:
        return None

    turns_since_reminder = _count_assistant_turns_since_last_reminder(messages)
    if turns_since_reminder < TASK_REMINDER_CONFIG["TURNS_BETWEEN_REMINDERS"]:
        return None

    reminder_text = (
        "The task tools haven't been used recently. "
        "If you're working on tasks that would benefit from tracking progress, "
        "consider using TaskCreate to add new tasks and TaskUpdate to update task status "
        "(set to in_progress when starting, completed when done). "
        "Also consider cleaning up the task list if it has become stale. "
        "Only use these if relevant to the current work. "
        "This is just a gentle reminder - ignore if not applicable. "
        "Make sure that you NEVER mention this reminder to the user."
    )

    task_list_text = _get_current_task_list_text(cwd)
    if task_list_text:
        reminder_text += f"\n\nHere are the existing tasks:\n{task_list_text}"

    logger.debug(
        "Injecting task reminder (turns since tool: {}, since reminder: {})",
        turns_since_tool,
        turns_since_reminder,
    )

    return create_user_message(content=reminder_text)
