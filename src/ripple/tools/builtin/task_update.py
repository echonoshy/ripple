"""TaskUpdate 工具

更新任务状态和属性。
"""

from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tasks.manager import TaskManager, get_task_manager
from ripple.tasks.models import TaskStatus
from ripple.tools.base import Tool, ToolResult


class TaskUpdateInput(BaseModel):
    """TaskUpdate 工具输入"""

    taskId: str = Field(description="要更新的任务 ID")  # noqa: N815
    status: TaskStatus | None = Field(default=None, description="新状态")
    owner: str | None = Field(default=None, description="新负责人")
    subject: str | None = Field(default=None, description="新标题")
    description: str | None = Field(default=None, description="新描述")
    activeForm: str | None = Field(default=None, description="新动词形式")  # noqa: N815
    addBlocks: list[str] | None = Field(default=None, description="添加阻塞的任务 ID")  # noqa: N815
    addBlockedBy: list[str] | None = Field(default=None, description="添加被阻塞的任务 ID")  # noqa: N815
    metadata: dict[str, Any] | None = Field(default=None, description="要合并的元数据")


class TaskUpdateOutput(BaseModel):
    """TaskUpdate 工具输出"""

    task_id: str
    status: TaskStatus
    subject: str


class TaskUpdateTool(Tool[TaskUpdateInput, TaskUpdateOutput]):
    """TaskUpdate 工具

    更新任务的状态、负责人、依赖关系等。
    """

    def __init__(self, task_manager: TaskManager | None = None):
        self.name = "TaskUpdate"
        self.description = "Update a task in the task list"
        self.max_result_size_chars = 10_000
        self._task_manager = task_manager

    def _get_task_manager(self, context: ToolUseContext) -> TaskManager:
        """获取任务管理器实例"""
        if self._task_manager:
            return self._task_manager
        return get_task_manager(context.cwd / ".ripple" / "tasks.json")

    async def call(
        self,
        args: TaskUpdateInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[TaskUpdateOutput]:
        """更新任务

        Args:
            args: 更新参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            更新后的任务信息
        """
        # 解析输入
        if isinstance(args, dict):
            args = TaskUpdateInput(**args)

        # 获取任务管理器
        task_manager = self._get_task_manager(context)

        # 更新任务
        task = task_manager.update_task(
            task_id=args.taskId,
            status=args.status,
            owner=args.owner,
            subject=args.subject,
            description=args.description,
            active_form=args.activeForm,
            add_blocks=args.addBlocks,
            add_blocked_by=args.addBlockedBy,
            metadata=args.metadata,
        )

        output = TaskUpdateOutput(task_id=task.id, status=task.status, subject=task.subject)

        return ToolResult(data=output)

    def is_concurrency_safe(self, input: TaskUpdateInput | dict[str, Any]) -> bool:
        """TaskUpdate 不是并发安全的（需要写入文件）"""
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema"""
        return {
            "type": "object",
            "properties": {
                "taskId": {"type": "string", "description": "The ID of the task to update"},
                "status": {
                    "type": "string",
                    "enum": ["pending", "in_progress", "completed", "deleted"],
                    "description": "New status for the task",
                },
                "owner": {"type": "string", "description": "New owner for the task"},
                "subject": {"type": "string", "description": "New subject for the task"},
                "description": {"type": "string", "description": "New description for the task"},
                "activeForm": {"type": "string", "description": "New active form for the task"},
                "addBlocks": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Task IDs that this task blocks",
                },
                "addBlockedBy": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Task IDs that block this task",
                },
                "metadata": {
                    "type": "object",
                    "description": "Metadata keys to merge into the task. Set a key to null to delete it.",
                },
            },
            "required": ["taskId"],
        }
