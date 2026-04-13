"""任务管理器

负责任务的创建、更新、查询和持久化。
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from ripple.tasks.models import Task, TaskStatus
from ripple.utils.logger import get_logger

logger = get_logger("tasks.manager")

_instances: dict[str, "TaskManager"] = {}


def get_task_manager(storage_path: Path | None = None) -> "TaskManager":
    """获取 TaskManager 单例（按存储路径缓存）

    Args:
        storage_path: 任务存储路径

    Returns:
        TaskManager 实例
    """
    if storage_path is None:
        storage_path = Path.cwd() / ".ripple" / "tasks.json"

    key = str(storage_path)
    if key not in _instances:
        _instances[key] = TaskManager(storage_path)
    return _instances[key]


class TaskManager:
    """任务管理器

    管理任务的生命周期，包括创建、更新、查询和持久化。
    """

    def __init__(self, storage_path: Path | None = None):
        """初始化任务管理器

        Args:
            storage_path: 任务存储路径，默认为 .ripple/tasks.json
        """
        if storage_path is None:
            storage_path = Path.cwd() / ".ripple" / "tasks.json"

        self.storage_path = storage_path
        self.tasks: dict[str, Task] = {}
        self._load_tasks()

    def _load_tasks(self):
        """从磁盘加载任务"""
        if not self.storage_path.exists():
            logger.debug("任务文件不存在，初始化为空: {}", self.storage_path)
            return

        try:
            with open(self.storage_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            for task_id, task_data in data.items():
                self.tasks[task_id] = Task(**task_data)

            logger.info("加载了 {} 个任务", len(self.tasks))
        except Exception as e:
            logger.error("加载任务失败: {}", e)
            self.tasks = {}

    def _save_tasks(self):
        """保存任务到磁盘"""
        try:
            # 确保目录存在
            self.storage_path.parent.mkdir(parents=True, exist_ok=True)

            # 序列化任务
            data = {task_id: task.model_dump(mode="json") for task_id, task in self.tasks.items()}

            # 写入文件
            with open(self.storage_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

            logger.debug("保存了 {} 个任务到 {}", len(self.tasks), self.storage_path)
        except Exception as e:
            logger.error("保存任务失败: {}", e)

    def create_task(
        self,
        subject: str,
        description: str,
        active_form: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """创建新任务

        Args:
            subject: 任务标题
            description: 任务描述
            active_form: 进行中时的动词形式
            metadata: 任务元数据

        Returns:
            任务 ID
        """
        existing_ids = [int(tid) for tid in self.tasks if tid.isdigit()]
        task_id = str(max(existing_ids, default=0) + 1)

        task = Task(
            id=task_id,
            subject=subject,
            description=description,
            active_form=active_form,
            metadata=metadata or {},
        )

        self.tasks[task_id] = task
        self._save_tasks()

        logger.info("创建任务 #{}: {}", task_id, subject)
        return task_id

    def update_task(
        self,
        task_id: str,
        status: TaskStatus | None = None,
        owner: str | None = None,
        subject: str | None = None,
        description: str | None = None,
        active_form: str | None = None,
        add_blocks: list[str] | None = None,
        add_blocked_by: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Task:
        """更新任务

        Args:
            task_id: 任务 ID
            status: 新状态
            owner: 新负责人
            subject: 新标题
            description: 新描述
            active_form: 新动词形式
            add_blocks: 添加阻塞的任务 ID
            add_blocked_by: 添加被阻塞的任务 ID
            metadata: 要合并的元数据（设置为 None 的键会被删除）

        Returns:
            更新后的任务

        Raises:
            KeyError: 任务不存在
        """
        if task_id not in self.tasks:
            raise KeyError(f"Task #{task_id} not found")

        task = self.tasks[task_id]

        # 更新字段
        if status is not None:
            task.status = status
        if owner is not None:
            task.owner = owner
        if subject is not None:
            task.subject = subject
        if description is not None:
            task.description = description
        if active_form is not None:
            task.active_form = active_form

        # 更新依赖关系
        if add_blocks:
            task.blocks = list(set(task.blocks + add_blocks))
        if add_blocked_by:
            task.blocked_by = list(set(task.blocked_by + add_blocked_by))

        # 合并元数据
        if metadata:
            for key, value in metadata.items():
                if value is None:
                    task.metadata.pop(key, None)
                else:
                    task.metadata[key] = value

        # 更新时间戳
        task.updated_at = datetime.now()

        self._save_tasks()

        logger.info("更新任务 #{}: {}", task_id, task.subject)
        return task

    def get_task(self, task_id: str) -> Task:
        """获取任务

        Args:
            task_id: 任务 ID

        Returns:
            任务对象

        Raises:
            KeyError: 任务不存在
        """
        if task_id not in self.tasks:
            raise KeyError(f"Task #{task_id} not found")

        return self.tasks[task_id]

    def list_tasks(self, include_deleted: bool = False) -> list[Task]:
        """列出所有任务

        Args:
            include_deleted: 是否包含已删除的任务

        Returns:
            任务列表（按 ID 排序）
        """
        tasks = list(self.tasks.values())

        if not include_deleted:
            tasks = [t for t in tasks if t.status != TaskStatus.DELETED]

        # 按 ID 排序
        tasks.sort(key=lambda t: int(t.id))

        return tasks

    def get_available_tasks(self, owner: str | None = None) -> list[Task]:
        """获取可以开始的任务

        Args:
            owner: 筛选特定负责人的任务（None 表示无负责人或所有任务）

        Returns:
            可以开始的任务列表
        """
        available = []

        for task in self.tasks.values():
            # 跳过已删除的任务
            if task.status == TaskStatus.DELETED:
                continue

            # 筛选负责人
            if owner is not None and task.owner != owner:
                continue

            # 检查是否可以开始
            if task.can_start(self.tasks):
                available.append(task)

        return available

    def delete_task(self, task_id: str):
        """删除任务（软删除）

        Args:
            task_id: 任务 ID

        Raises:
            KeyError: 任务不存在
        """
        if task_id not in self.tasks:
            raise KeyError(f"Task #{task_id} not found")

        self.tasks[task_id].status = TaskStatus.DELETED
        self.tasks[task_id].updated_at = datetime.now()
        self._save_tasks()

        logger.info("删除任务 #{}", task_id)

    def clear_all_tasks(self):
        """清空所有任务"""
        self.tasks.clear()
        self._save_tasks()
        logger.info("清空所有任务")
