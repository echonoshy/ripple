"""TaskCreate 工具

创建新任务。
"""

from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tasks.manager import TaskManager, get_task_manager
from ripple.tools.base import Tool, ToolResult


class TaskCreateInput(BaseModel):
    """TaskCreate 工具输入"""

    subject: str = Field(description="任务标题（简短、可操作的描述）")
    description: str = Field(description="任务详细描述")
    activeForm: str | None = Field(default=None, description="进行中时显示的动词形式（如 'Running tests')")  # noqa: N815
    metadata: dict[str, Any] | None = Field(default=None, description="任务元数据")


class TaskCreateOutput(BaseModel):
    """TaskCreate 工具输出"""

    task_id: str
    subject: str


class TaskCreateTool(Tool[TaskCreateInput, TaskCreateOutput]):
    """TaskCreate 工具

    创建新任务到任务列表中。
    """

    def __init__(self, task_manager: TaskManager | None = None):
        self.name = "TaskCreate"
        self.description = "Create a new task in the task list"
        self.max_result_size_chars = 10_000
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
        args: TaskCreateInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[TaskCreateOutput]:
        """创建任务

        Args:
            args: 任务参数
            context: 工具使用上下文
            parent_message: 父助手消息

        Returns:
            任务 ID 和标题
        """
        # 解析输入
        if isinstance(args, dict):
            args = TaskCreateInput(**args)

        # 获取任务管理器
        task_manager = self._get_task_manager(context)

        # 创建任务
        task_id = task_manager.create_task(
            subject=args.subject,
            description=args.description,
            active_form=args.activeForm,
            metadata=args.metadata,
        )

        output = TaskCreateOutput(task_id=task_id, subject=args.subject)

        return ToolResult(data=output)

    def is_concurrency_safe(self, input: TaskCreateInput | dict[str, Any]) -> bool:
        """TaskCreate 不是并发安全的（需要写入文件）"""
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        """获取参数 schema"""
        return {
            "type": "object",
            "properties": {
                "subject": {
                    "type": "string",
                    "description": "A brief, actionable title in imperative form (e.g., 'Fix authentication bug in login flow')",
                },
                "description": {
                    "type": "string",
                    "description": "What needs to be done",
                },
                "activeForm": {
                    "type": "string",
                    "description": "Present continuous form shown in spinner when in_progress (e.g., 'Fixing authentication bug'). If omitted, the spinner shows the subject instead.",
                },
                "metadata": {
                    "type": "object",
                    "description": "Arbitrary metadata to attach to the task",
                },
            },
            "required": ["subject", "description"],
        }
