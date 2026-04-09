"""Session 持久化存储

将 execute 模式的 session 状态保存到磁盘，支持 continue 恢复。
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from ripple.utils.logger import get_logger

logger = get_logger("cli.session_store")

SESSIONS_DIR = Path.home() / ".ripple" / "sessions"


def _ensure_dir():
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def save_session(
    session_id: str,
    messages: list[dict[str, Any]],
    system_prompt: str,
    model: str,
    cwd: str,
    status: str = "completed",
    suspend_data: dict[str, Any] | None = None,
) -> Path:
    """保存 session 到磁盘"""
    _ensure_dir()

    data = {
        "session_id": session_id,
        "status": status,
        "messages": messages,
        "system_prompt": system_prompt,
        "model": model,
        "cwd": cwd,
        "created_at": datetime.now().isoformat(),
        "suspend_data": suspend_data,
    }

    path = _session_path(session_id)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    logger.info("Session 已保存: {}", path)
    return path


def load_session(session_id: str) -> dict[str, Any] | None:
    """从磁盘加载 session"""
    path = _session_path(session_id)
    if not path.exists():
        logger.warning("Session 文件不存在: {}", path)
        return None

    data = json.loads(path.read_text())
    logger.info("Session 已加载: {} (status={})", session_id, data.get("status"))
    return data


def update_session_status(session_id: str, status: str) -> bool:
    """更新 session 状态"""
    data = load_session(session_id)
    if data is None:
        return False

    data["status"] = status
    data["updated_at"] = datetime.now().isoformat()
    path = _session_path(session_id)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return True


def list_sessions(limit: int = 20) -> list[dict[str, Any]]:
    """列出最近的 sessions"""
    _ensure_dir()

    sessions = []
    for path in sorted(SESSIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        if len(sessions) >= limit:
            break
        try:
            data = json.loads(path.read_text())
            sessions.append(
                {
                    "session_id": data.get("session_id", path.stem),
                    "status": data.get("status", "unknown"),
                    "model": data.get("model", ""),
                    "cwd": data.get("cwd", ""),
                    "created_at": data.get("created_at", ""),
                    "message_count": len(data.get("messages", [])),
                }
            )
        except (json.JSONDecodeError, OSError):
            continue

    return sessions


def delete_session(session_id: str) -> bool:
    """删除 session"""
    path = _session_path(session_id)
    if path.exists():
        path.unlink()
        return True
    return False
