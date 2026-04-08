"""后台任务管理

支持异步执行 agent 任务并通过通知机制返回结果。
"""

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncGenerator
from uuid import uuid4

from ripple.messages.types import Message, RequestStartEvent, StreamEvent
from ripple.messages.utils import create_user_message


@dataclass
class BackgroundTask:
    """后台任务"""

    task_id: str
    description: str
    prompt: str
    status: str = "running"  # running, completed, failed
    result: str | None = None
    output_file: Path | None = None
    error: str | None = None
    turns_used: int = 0


@dataclass
class TaskManager:
    """任务管理器"""

    tasks: dict[str, BackgroundTask] = field(default_factory=dict)
    _running_tasks: dict[str, asyncio.Task] = field(default_factory=dict)

    def create_task(self, description: str, prompt: str, output_dir: Path | None = None) -> BackgroundTask:
        """创建后台任务

        Args:
            description: 任务描述
            prompt: 任务提示词
            output_dir: 输出目录（可选）

        Returns:
            后台任务对象
        """
        task_id = f"task-{uuid4().hex[:8]}"

        # 创建输出文件
        output_file = None
        if output_dir:
            output_dir.mkdir(parents=True, exist_ok=True)
            output_file = output_dir / f"{task_id}.txt"

        task = BackgroundTask(
            task_id=task_id,
            description=description,
            prompt=prompt,
            output_file=output_file,
        )

        self.tasks[task_id] = task
        return task

    def start_task(
        self,
        task: BackgroundTask,
        coro: AsyncGenerator[Message | StreamEvent | RequestStartEvent, Any],
    ) -> None:
        """启动后台任务

        Args:
            task: 后台任务对象
            coro: 异步生成器（agent loop）
        """
        async_task = asyncio.create_task(self._run_task(task, coro))
        self._running_tasks[task.task_id] = async_task

    async def _run_task(
        self,
        task: BackgroundTask,
        coro: AsyncGenerator[Message | StreamEvent | RequestStartEvent, Any],
    ) -> None:
        """运行后台任务

        Args:
            task: 后台任务对象
            coro: 异步生成器（agent loop）
        """
        output_lines = []
        turns_used = 0

        try:
            async for item in coro:
                # 收集输出
                if hasattr(item, "type"):
                    if item.type == "assistant":
                        turns_used += 1
                        # 提取文本内容
                        for block in item.message.get("content", []):
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "").strip()
                                if text:
                                    output_lines.append(text)

            # 任务完成
            task.status = "completed"
            task.result = "\n\n".join(output_lines) if output_lines else "Task completed with no text output."
            task.turns_used = turns_used

            # 写入输出文件
            if task.output_file:
                task.output_file.write_text(task.result, encoding="utf-8")

        except Exception as e:
            # 任务失败
            task.status = "failed"
            task.error = str(e)
            task.result = f"Task failed: {e}"

            if task.output_file:
                task.output_file.write_text(task.result, encoding="utf-8")

        finally:
            # 清理
            if task.task_id in self._running_tasks:
                del self._running_tasks[task.task_id]

    def get_task(self, task_id: str) -> BackgroundTask | None:
        """获取任务

        Args:
            task_id: 任务 ID

        Returns:
            后台任务对象或 None
        """
        return self.tasks.get(task_id)

    def list_tasks(self) -> list[BackgroundTask]:
        """列出所有任务

        Returns:
            任务列表
        """
        return list(self.tasks.values())

    async def wait_for_task(self, task_id: str) -> BackgroundTask | None:
        """等待任务完成

        Args:
            task_id: 任务 ID

        Returns:
            后台任务对象或 None
        """
        task = self.tasks.get(task_id)
        if not task:
            return None

        # 如果任务还在运行，等待完成
        if task_id in self._running_tasks:
            await self._running_tasks[task_id]

        return task

    def cancel_task(self, task_id: str) -> bool:
        """取消任务

        Args:
            task_id: 任务 ID

        Returns:
            是否成功取消
        """
        if task_id not in self._running_tasks:
            return False

        async_task = self._running_tasks[task_id]
        async_task.cancel()

        task = self.tasks.get(task_id)
        if task:
            task.status = "cancelled"
            task.result = "Task cancelled by user"

        return True


# 全局任务管理器实例
_global_task_manager: TaskManager | None = None


def get_task_manager() -> TaskManager:
    """获取全局任务管理器

    Returns:
        任务管理器实例
    """
    global _global_task_manager
    if _global_task_manager is None:
        _global_task_manager = TaskManager()
    return _global_task_manager


def create_task_notification(task: BackgroundTask) -> Message:
    """创建任务通知消息

    Args:
        task: 后台任务对象

    Returns:
        通知消息
    """
    if task.status == "completed":
        content = f"""<task-notification>
Background task completed: {task.description}

Task ID: {task.task_id}
Turns used: {task.turns_used}
Output file: {task.output_file}

Result:
{task.result}
</task-notification>"""
    elif task.status == "failed":
        content = f"""<task-notification>
Background task failed: {task.description}

Task ID: {task.task_id}
Error: {task.error}
</task-notification>"""
    else:
        content = f"""<task-notification>
Background task started: {task.description}

Task ID: {task.task_id}
Status: {task.status}
Output file: {task.output_file}

You will be notified when the task completes.
</task-notification>"""

    return create_user_message(content=content, is_meta=True)
