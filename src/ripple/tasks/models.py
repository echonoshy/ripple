"""任务数据模型

定义任务的数据结构和状态。
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    """任务状态"""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    DELETED = "deleted"


class Task(BaseModel):
    """任务模型"""

    id: str = Field(description="任务唯一标识符")
    subject: str = Field(description="任务标题（简短描述）")
    description: str = Field(description="任务详细描述")
    status: TaskStatus = Field(default=TaskStatus.PENDING, description="任务状态")
    owner: str | None = Field(default=None, description="任务负责人（agent 名称）")
    blocks: list[str] = Field(default_factory=list, description="此任务阻塞的任务 ID 列表")
    blocked_by: list[str] = Field(default_factory=list, description="阻塞此任务的任务 ID 列表")
    active_form: str | None = Field(default=None, description="进行中时显示的动词形式")
    metadata: dict[str, Any] = Field(default_factory=dict, description="任务元数据")
    created_at: datetime = Field(default_factory=datetime.now, description="创建时间")
    updated_at: datetime = Field(default_factory=datetime.now, description="更新时间")

    def is_blocked(self, all_tasks: dict[str, "Task"]) -> bool:
        """检查任务是否被阻塞

        Args:
            all_tasks: 所有任务的字典

        Returns:
            如果有未完成的阻塞任务则返回 True
        """
        for blocker_id in self.blocked_by:
            blocker = all_tasks.get(blocker_id)
            if blocker and blocker.status != TaskStatus.COMPLETED:
                return True
        return False

    def can_start(self, all_tasks: dict[str, "Task"]) -> bool:
        """检查任务是否可以开始

        Args:
            all_tasks: 所有任务的字典

        Returns:
            如果任务是 pending 且未被阻塞则返回 True
        """
        return self.status == TaskStatus.PENDING and not self.is_blocked(all_tasks)
