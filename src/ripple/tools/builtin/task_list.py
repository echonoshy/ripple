"""TaskList 工具

列出所有任务。
"""

from typing import Any

from pydantic import BaseModel

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tasks.manager import TaskManager, get_task_manager
from ripple.tasks.models import TaskStatus
from ripple.tools.base import Tool, ToolResult


class TaskListInput(BaseModel):
    """TaskList 工具输入（无参数）"""

    pass


class TaskSummary(BaseModel):
    """任务摘要"""

    id: str
    subject: str
    status: TaskStatus
    owner: str | None
    blocked_by: list[str]


class TaskListOutput(BaseModel):
    """TaskList 工具输出"""

    tasks: list[TaskSummary]
    total: int


class TaskListTool(Tool[TaskListInput, TaskListOutput]):
    """TaskList 工具

    列出所有任务的摘要信息。
    """

    def __init__(self, task_manager: TaskManager | None = None):
        self.name = "TaskList"
        self.description = "List all tasks in the task list"
        self.max_result_size_chars = 50_000
        self._task_manager = task_manager

    def _get_task_manager(self, context: ToolUseContext) -> TaskManager:
        """获取任务管理器实例"""
        if self._task_manager:
            return self._task_manager
        if context.session_runtime_dir is not None:
            return get_task_manager(context.session_runtime_dir / "tasks.json")
        return get_task_manager(context.cwd / ".ripple" / "tasks.json")

    async def call(
        self,
        args: TaskListInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[TaskListOutput]:
        """列出所有任务

        Args:
            args: 输入参数（空）
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            任务列表
        """
        # 获取任务管理器
        task_manager = self._get_task_manager(context)

        # 获取所有任务
        tasks = task_manager.list_tasks(include_deleted=False)

        # 转换为摘要格式
        summaries = [
            TaskSummary(
                id=task.id,
                subject=task.subject,
                status=task.status,
                owner=task.owner,
                blocked_by=task.blocked_by,
            )
            for task in tasks
        ]

        output = TaskListOutput(tasks=summaries, total=len(summaries))

        return ToolResult(data=output)

    def is_concurrency_safe(self, input: TaskListInput | dict[str, Any]) -> bool:
        """TaskList 是只读的，可以并发执行"""
        return True

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema"""
        return {
            "type": "object",
            "properties": {},
            "required": [],
        }
