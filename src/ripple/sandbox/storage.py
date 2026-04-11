"""会话状态持久化

将 session 的对话历史和元数据保存到磁盘，支持挂起/恢复。
使用原子写操作（写临时文件 + rename）防止数据损坏。
"""

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.storage")


def _serialize_message(msg: Any) -> dict:
    """将消息对象序列化为可 JSON 化的 dict"""
    if hasattr(msg, "model_dump"):
        return msg.model_dump()
    if isinstance(msg, dict):
        return msg
    return {"type": "unknown", "data": str(msg)}


def _deserialize_messages(data_list: list[dict]) -> list[dict]:
    """反序列化消息列表

    保持为 dict 格式 — agent_loop 的 normalize_messages_for_api 会处理类型转换。
    """
    return data_list


def extract_title_from_messages(messages: list) -> str:
    """从消息列表中提取标题（第一条用户消息的前 50 字符）"""
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        if isinstance(content, str) and content.strip():
            return content[:50].strip()
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text", "")
                    if text.strip():
                        return text[:50].strip()
    return ""


def save_session_state(
    config: SandboxConfig,
    session_id: str,
    *,
    messages: list,
    model: str,
    system_prompt: str | None,
    max_turns: int,
    total_input_tokens: int = 0,
    total_output_tokens: int = 0,
    created_at: datetime | None = None,
    last_active: datetime | None = None,
) -> Path:
    """保存 session 状态到磁盘（原子写）"""
    state = {
        "version": 1,
        "session_id": session_id,
        "title": extract_title_from_messages(messages),
        "model": model,
        "system_prompt": system_prompt,
        "max_turns": max_turns,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "created_at": (created_at or datetime.now(timezone.utc)).isoformat(),
        "last_active": (last_active or datetime.now(timezone.utc)).isoformat(),
        "suspended_at": datetime.now(timezone.utc).isoformat(),
        "messages": [_serialize_message(m) for m in messages],
    }

    state_file = config.state_file(session_id)
    state_file.parent.mkdir(parents=True, exist_ok=True)

    # 原子写：先写临时文件，再 rename
    fd, tmp_path = tempfile.mkstemp(dir=state_file.parent, suffix=".tmp")
    try:
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2, default=str)
        Path(tmp_path).rename(state_file)
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise

    logger.info("保存 session 状态: {} ({} 条消息)", session_id, len(messages))
    return state_file


def load_session_state(config: SandboxConfig, session_id: str) -> dict | None:
    """从磁盘加载 session 状态"""
    state_file = config.state_file(session_id)
    if not state_file.exists():
        return None

    with open(state_file, encoding="utf-8") as f:
        state = json.load(f)

    state["messages"] = _deserialize_messages(state.get("messages", []))
    logger.info("加载 session 状态: {} ({} 条消息)", session_id, len(state["messages"]))
    return state


def delete_session_state(config: SandboxConfig, session_id: str) -> bool:
    """删除 session 持久化状态"""
    state_file = config.state_file(session_id)
    if state_file.exists():
        state_file.unlink()
        logger.info("删除 session 状态文件: {}", session_id)
        return True
    return False


def get_suspended_session_info(config: SandboxConfig, session_id: str) -> dict | None:
    """获取已挂起 session 的摘要信息（不加载完整消息）"""
    state_file = config.state_file(session_id)
    if not state_file.exists():
        return None

    with open(state_file, encoding="utf-8") as f:
        state = json.load(f)

    return {
        "session_id": state.get("session_id", session_id),
        "title": state.get("title", ""),
        "model": state.get("model", ""),
        "max_turns": state.get("max_turns", 10),
        "message_count": len(state.get("messages", [])),
        "total_input_tokens": state.get("total_input_tokens", 0),
        "total_output_tokens": state.get("total_output_tokens", 0),
        "created_at": state.get("created_at", ""),
        "last_active": state.get("last_active", ""),
        "suspended_at": state.get("suspended_at", ""),
    }
