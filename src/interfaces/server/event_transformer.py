"""事件转换器：将 Agent Loop 事件转换为 WebSocket JSON 格式"""

import re
import time
from typing import Any

from ripple.messages.types import AssistantMessage, UserMessage


class EventTransformer:
    """将 Agent Loop 事件转换为 WebSocket JSON 格式"""

    @staticmethod
    def transform(item: Any) -> dict[str, Any] | list[dict[str, Any]] | None:
        """转换事件

        Args:
            item: Agent Loop 产出的事件

        Returns:
            WebSocket JSON 事件（单个或多个）
        """

        # 1. 请求开始事件
        if hasattr(item, "type") and item.type == "stream_request_start":
            return {
                "type": "thinking_start",
                "timestamp": time.time(),
            }

        # 2. 助手消息
        elif isinstance(item, AssistantMessage):
            content = item.message.get("content", [])
            usage = item.message.get("usage", {})

            events = []

            # 处理每个内容块
            for block in content:
                if isinstance(block, dict):
                    block_type = block.get("type")

                    # 文本块
                    if block_type == "text":
                        text = block.get("text", "")
                        if text.strip():
                            events.append(
                                {
                                    "type": "text",
                                    "content": text,
                                    "timestamp": time.time(),
                                }
                            )

                    # 工具调用块
                    elif block_type == "tool_use":
                        events.append(
                            {
                                "type": "tool_call",
                                "tool_id": block.get("id"),
                                "tool_name": block.get("name"),
                                "tool_input": block.get("input", {}),
                                "timestamp": time.time(),
                            }
                        )

            # 添加 token 使用信息
            if usage:
                events.append(
                    {
                        "type": "token_usage",
                        "input_tokens": usage.get("input_tokens", 0),
                        "output_tokens": usage.get("output_tokens", 0),
                        "timestamp": time.time(),
                    }
                )

            return events if len(events) > 1 else (events[0] if events else None)

        # 3. 用户消息（工具结果）
        elif isinstance(item, UserMessage):
            content = item.message.get("content", [])

            events = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_use_id = block.get("tool_use_id")
                    result_content = block.get("content", "")
                    is_error = block.get("is_error", False)

                    # 检查是否是 SubAgent 结果
                    subagent_data = None
                    if "SubAgentOutput" in result_content or "execution_log" in result_content:
                        subagent_data = EventTransformer._parse_subagent_output(result_content)

                    events.append(
                        {
                            "type": "tool_result",
                            "tool_id": tool_use_id,
                            "is_error": is_error,
                            "content": result_content,
                            "subagent_data": subagent_data,
                            "timestamp": time.time(),
                        }
                    )

            return events if len(events) > 1 else (events[0] if events else None)

        return None

    @staticmethod
    def _parse_subagent_output(result_content: str) -> dict[str, Any] | None:
        """解析 SubAgent 输出

        Args:
            result_content: SubAgent 的输出内容

        Returns:
            解析后的数据或 None
        """
        try:
            import ast

            # 提取 execution_log
            match = re.search(r"execution_log=\[(.*?)\]\s*(?:,\s*\)|$)", result_content, re.DOTALL)
            execution_log = []
            if match:
                log_str = "[" + match.group(1) + "]"
                execution_log = ast.literal_eval(log_str)

            # 提取 result
            result_match = re.search(r"result='(.*?)'(?=,\s*turns_used)", result_content, re.DOTALL)
            result = result_match.group(1) if result_match else ""

            # 提取 turns_used
            turns_match = re.search(r"turns_used=(\d+)", result_content)
            turns_used = int(turns_match.group(1)) if turns_match else 0

            return {
                "result": result,
                "turns_used": turns_used,
                "execution_log": execution_log,
            }
        except Exception:
            return None
