"""会话记录模块

将聊天会话保存为 JSONL 文件，支持回顾历史对话。
会话文件存储在 ~/.ripple/conversations/ 目录下。
"""

import json
from datetime import datetime
from typing import Any

from ripple.utils.logger import RIPPLE_HOME, get_logger

logger = get_logger("conversation")

CONVERSATION_DIR = RIPPLE_HOME / "conversations"


def _ensure_dir():
    CONVERSATION_DIR.mkdir(parents=True, exist_ok=True)


class ConversationLogger:
    """会话记录器

    每个 CLI 会话对应一个 JSONL 文件，记录所有对话内容。
    """

    def __init__(self, session_id: str | None = None):
        _ensure_dir()
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.session_id = session_id or timestamp
        self.filepath = CONVERSATION_DIR / f"{timestamp}_{self.session_id}.jsonl"
        self._write_meta(timestamp)
        logger.info("会话记录已创建: {}", self.filepath)

    def _write_meta(self, timestamp: str):
        """写入会话元数据"""
        meta = {
            "type": "session_start",
            "session_id": self.session_id,
            "timestamp": timestamp,
            "start_time": datetime.now().isoformat(),
        }
        self._append(meta)

    def _append(self, data: dict[str, Any]):
        """追加一条记录到 JSONL 文件"""
        try:
            with open(self.filepath, "a", encoding="utf-8") as f:
                f.write(json.dumps(data, ensure_ascii=False, default=str) + "\n")
        except Exception as e:
            logger.error("写入会话记录失败: {}", e)

    def log_user_message(self, content: str):
        """记录用户消息"""
        self._append(
            {
                "type": "user",
                "content": content,
                "timestamp": datetime.now().isoformat(),
            }
        )

    def log_assistant_message(self, content: str):
        """记录助手回复"""
        self._append(
            {
                "type": "assistant",
                "content": content,
                "timestamp": datetime.now().isoformat(),
            }
        )

    def log_tool_call(self, tool_name: str, tool_input: dict[str, Any]):
        """记录工具调用"""
        self._append(
            {
                "type": "tool_call",
                "tool_name": tool_name,
                "tool_input": tool_input,
                "timestamp": datetime.now().isoformat(),
            }
        )

    def log_tool_result(self, tool_name: str, content: str, is_error: bool = False):
        """记录工具执行结果"""
        self._append(
            {
                "type": "tool_result",
                "tool_name": tool_name,
                "content": content[:2000],
                "is_error": is_error,
                "timestamp": datetime.now().isoformat(),
            }
        )

    def log_error(self, error: str, traceback_str: str | None = None):
        """记录错误"""
        self._append(
            {
                "type": "error",
                "error": error,
                "traceback": traceback_str,
                "timestamp": datetime.now().isoformat(),
            }
        )

    def log_session_end(self):
        """记录会话结束"""
        self._append(
            {
                "type": "session_end",
                "timestamp": datetime.now().isoformat(),
            }
        )
        logger.info("会话记录已关闭: {}", self.filepath)


def list_conversations(limit: int = 20) -> list[dict[str, Any]]:
    """列出最近的会话记录

    Args:
        limit: 返回的最大数量

    Returns:
        会话信息列表（最新的在前）
    """
    _ensure_dir()
    files = sorted(CONVERSATION_DIR.glob("*.jsonl"), reverse=True)
    results = []

    for f in files[:limit]:
        try:
            with open(f, encoding="utf-8") as fp:
                first_line = fp.readline()
                meta = json.loads(first_line)
                line_count = sum(1 for _ in fp) + 1
                results.append(
                    {
                        "file": f.name,
                        "path": str(f),
                        "session_id": meta.get("session_id", ""),
                        "start_time": meta.get("start_time", ""),
                        "messages": line_count,
                    }
                )
        except Exception:
            continue

    return results
