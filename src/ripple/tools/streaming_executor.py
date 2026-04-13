"""流式工具执行器

在模型流式输出时并行执行并发安全的工具，提升响应速度。
参考 Claude Code 的 StreamingToolExecutor 设计。
"""

import asyncio
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tools.orchestration import MessageUpdate, execute_tool, find_tool_by_name
from ripple.utils.logger import get_logger

logger = get_logger("tools.streaming_executor")


class StreamingToolExecutor:
    """流式工具执行器

    在模型流式输出 tool_use 时立即开始执行并发安全的工具，
    而不是等待整个响应完成后再执行。
    """

    def __init__(self, context: ToolUseContext):
        self.context = context
        self._tasks: dict[str, asyncio.Task] = {}
        self._results: asyncio.Queue[tuple[str, MessageUpdate | None]] = asyncio.Queue()
        self._started_tool_ids: set[str] = set()
        self._discarded = False

    def add_tool(self, tool_block: dict[str, Any], parent_message: AssistantMessage) -> bool:
        """添加工具调用并立即开始执行（如果并发安全）

        Returns:
            True 如果工具已被接管并开始执行，False 如果需要走原有路径
        """
        if self._discarded:
            return False

        tool_id = tool_block["id"]
        if tool_id in self._started_tool_ids:
            return True

        tool_name = tool_block.get("name", "unknown")
        tool = find_tool_by_name(self.context.options.tools, tool_name)
        if not tool:
            return False

        try:
            is_safe = tool.is_concurrency_safe(tool_block.get("input", {}))
        except Exception:
            is_safe = False

        if not is_safe:
            return False

        self._started_tool_ids.add(tool_id)
        logger.info("流式并行执行工具: {}", tool_name)
        task = asyncio.create_task(self._execute_and_queue(tool_id, tool_block, parent_message))
        self._tasks[tool_id] = task
        return True

    async def _execute_and_queue(self, tool_id: str, tool_block: dict[str, Any], parent_message: AssistantMessage):
        """执行工具并将结果放入队列"""
        try:
            async for update in execute_tool(tool_block, parent_message, self.context):
                if self._discarded:
                    return
                await self._results.put((tool_id, update))
        except Exception as e:
            logger.error("流式工具执行失败 ({}): {}", tool_block.get("name", "?"), e)
            await self._results.put((tool_id, None))

    def get_completed_results(self) -> list[MessageUpdate]:
        """获取已完成的工具结果（非阻塞）"""
        results = []
        while not self._results.empty():
            try:
                _, update = self._results.get_nowait()
                if update is not None:
                    results.append(update)
            except asyncio.QueueEmpty:
                break
        return results

    async def get_remaining_results(self) -> list[MessageUpdate]:
        """等待所有工具完成并返回所有剩余结果"""
        if not self._tasks:
            return []

        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

        results = []
        while not self._results.empty():
            try:
                _, update = self._results.get_nowait()
                if update is not None:
                    results.append(update)
            except asyncio.QueueEmpty:
                break

        return results

    def has_pending_tools(self) -> bool:
        """检查是否有已启动但未完成的工具"""
        return any(not task.done() for task in self._tasks.values())

    @property
    def started_tool_ids(self) -> set[str]:
        """返回已被 streaming executor 接管的工具 ID 集合"""
        return self._started_tool_ids

    def discard(self):
        """丢弃当前执行器（用于 fallback/abort 场景）"""
        self._discarded = True
        for task in self._tasks.values():
            if not task.done():
                task.cancel()
        self._tasks.clear()
        self._started_tool_ids.clear()
