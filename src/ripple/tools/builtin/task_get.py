"""TaskGet 工具

获取任务详细信息。
"""

from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tasks.manager import TaskManager, get_task_manager
from ripple.tasks.models import Task
from ripple.tools.base import Tool, ToolResult


class TaskGetInput(BaseModel):
    """TaskGet 工具输入"""

    taskId: str = Field(description="要获取的任务 ID")  # noqa: N815


class TaskGetOutput(BaseModel):
    """TaskGet 工具输出"""

    task: Task


class TaskGetTool(Tool[TaskGetInput, TaskGetOutput]):
    """TaskGet 工具

    获取任务的完整详细信息。
    """

    def __init__(self, task_manager: TaskManager | None = None):
        self.name = "TaskGet"
        self.description = "Get detailed information about a specific task"
        self.max_result_size_chars = 20_000
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
        args: TaskGetInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[TaskGetOutput]:
        """获取任务详情

        Args:
            args: 输入参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            任务详细信息
        """
        # 解析输入
        if isinstance(args, dict):
            args = TaskGetInput(**args)

        # 获取任务管理器
        task_manager = self._get_task_manager(context)

        # 获取任务
        try:
            task = task_manager.get_task(args.taskId)
        except KeyError as e:
            raise ValueError(f"Task #{args.taskId} not found") from e

        output = TaskGetOutput(task=task)

        return ToolResult(data=output)

    def is_concurrency_safe(self, input: TaskGetInput | dict[str, Any]) -> bool:
        """TaskGet 是只读的，可以并发执行"""
        return True

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema"""
        return {
            "type": "object",
            "properties": {
                "taskId": {"type": "string", "description": "The ID of the task to retrieve"},
            },
            "required": ["taskId"],
        }
