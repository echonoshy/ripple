"""会话状态持久化 — 分层存储

将 session 的元数据与消息历史分离存储：
- meta.json:   会话元数据、配置、状态（极小，频繁全量重写无压力）
- messages.jsonl: 对话历史（增量追加，避免全量重写）
"""

import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from ripple.messages.utils import deserialize_message, serialize_messages
from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.storage")

STATE_VERSION = 2


def extract_title_from_messages(messages: list) -> str:
    """从消息列表中提取标题（第一条用户消息的前 50 字符）"""
    for msg in messages:
        if isinstance(msg, dict):
            if "role" in msg and msg.get("role") != "user":
                continue
            if msg.get("type") not in (None, "user"):
                continue
            content = msg.get("content")
            if content is None and isinstance(msg.get("message"), dict):
                content = msg["message"].get("content", [])
        else:
            if getattr(msg, "type", None) != "user":
                continue
            content = msg.message.get("content", [])

        if isinstance(content, str) and content.strip():
            return content[:50].strip()

        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text", "")
                    if text.strip():
                        return text[:50].strip()
    return ""


def _atomic_write_json(path: Path, data: dict) -> None:
    """原子写 JSON 文件（写临时文件 + rename）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, default=str)
        Path(tmp_path).rename(path)
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise


def _atomic_write_lines(path: Path, lines: list[str]) -> None:
    """原子写多行文本文件"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with open(fd, "w", encoding="utf-8") as f:
            for line in lines:
                f.write(line + "\n")
        Path(tmp_path).rename(path)
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise


def save_session_state(
    config: SandboxConfig,
    session_id: str,
    *,
    messages: list,
    model: str,
    caller_system_prompt: str | None,
    max_turns: int,
    total_input_tokens: int = 0,
    total_output_tokens: int = 0,
    created_at: datetime | None = None,
    last_active: datetime | None = None,
    status: str = "idle",
    pending_question: str | None = None,
    pending_options: list[str] | None = None,
    pending_permission_request: dict | None = None,
    compactor_state: dict | None = None,
) -> Path:
    """保存 session 状态到磁盘（meta.json + messages.jsonl）

    meta.json 始终全量重写（体积极小）。
    messages.jsonl 增量追加新消息；若检测到 trim（消息数减少），则全量重写。
    """
    serialized_messages = serialize_messages(messages)
    new_count = len(serialized_messages)

    meta_file = config.meta_file(session_id)
    messages_file = config.messages_file(session_id)

    # 读取旧的消息数量，判断是追加还是全量重写
    old_count = 0
    if meta_file.exists():
        try:
            with open(meta_file, encoding="utf-8") as f:
                old_count = json.load(f).get("message_count", 0)
        except (json.JSONDecodeError, OSError):
            old_count = 0

    # --- 写 messages.jsonl ---
    new_lines = [json.dumps(msg, ensure_ascii=False) for msg in serialized_messages]

    if new_count > old_count > 0 and messages_file.exists():
        with open(messages_file, "a", encoding="utf-8") as f:
            for line in new_lines[old_count:]:
                f.write(line + "\n")
    else:
        _atomic_write_lines(messages_file, new_lines)

    # --- 写 meta.json ---
    meta = {
        "version": STATE_VERSION,
        "session_id": session_id,
        "title": extract_title_from_messages(messages),
        "model": model,
        "caller_system_prompt": caller_system_prompt,
        "max_turns": max_turns,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "created_at": (created_at or datetime.now(timezone.utc)).isoformat(),
        "last_active": (last_active or datetime.now(timezone.utc)).isoformat(),
        "suspended_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "pending_question": pending_question,
        "pending_options": pending_options,
        "pending_permission_request": pending_permission_request,
        "compactor_state": compactor_state,
        "message_count": new_count,
    }
    _atomic_write_json(meta_file, meta)

    logger.info("保存 session 状态: {} ({} 条消息, 追加 {})", session_id, new_count, max(0, new_count - old_count))
    return meta_file


def load_session_state(config: SandboxConfig, session_id: str) -> dict | None:
    """从磁盘加载 session 状态（meta.json + messages.jsonl）"""
    meta_file = config.meta_file(session_id)
    messages_file = config.messages_file(session_id)

    if not meta_file.exists():
        return None

    try:
        with open(meta_file, encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.error("加载 meta.json 失败: {} - {}", session_id, e)
        return None

    raw_messages = []
    if messages_file.exists():
        try:
            with open(messages_file, encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        raw_messages.append(json.loads(stripped))
                    except json.JSONDecodeError:
                        logger.warning("messages.jsonl 第 {} 行解析失败，跳过: {}", line_num, session_id)
        except OSError as e:
            logger.error("加载 messages.jsonl 失败: {} - {}", session_id, e)

    state["messages"] = [deserialize_message(item) for item in raw_messages]
    logger.info("加载 session 状态: {} ({} 条消息)", session_id, len(state["messages"]))
    return state


def delete_session_state(config: SandboxConfig, session_id: str) -> bool:
    """删除 session 持久化状态"""
    deleted = False
    for path in (config.meta_file(session_id), config.messages_file(session_id)):
        if path.exists():
            path.unlink()
            deleted = True
    if deleted:
        logger.info("删除 session 状态文件: {}", session_id)
    return deleted


def get_suspended_session_info(config: SandboxConfig, session_id: str) -> dict | None:
    """获取已挂起 session 的摘要信息（只读 meta.json，不解析消息）"""
    meta_file = config.meta_file(session_id)
    if not meta_file.exists():
        return None

    try:
        with open(meta_file, encoding="utf-8") as f:
            meta = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None

    return {
        "session_id": meta.get("session_id", session_id),
        "title": meta.get("title", ""),
        "model": meta.get("model", ""),
        "max_turns": meta.get("max_turns", 10),
        "message_count": meta.get("message_count", 0),
        "total_input_tokens": meta.get("total_input_tokens", 0),
        "total_output_tokens": meta.get("total_output_tokens", 0),
        "created_at": meta.get("created_at", ""),
        "last_active": meta.get("last_active", ""),
        "suspended_at": meta.get("suspended_at", ""),
    }


def save_session_state_uid(
    config: SandboxConfig,
    user_id: str,
    session_id: str,
    *,
    messages: list,
    model: str,
    caller_system_prompt: str | None,
    max_turns: int,
    total_input_tokens: int = 0,
    total_output_tokens: int = 0,
    created_at: datetime | None = None,
    last_active: datetime | None = None,
    status: str = "idle",
    pending_question: str | None = None,
    pending_options: list[str] | None = None,
    pending_permission_request: dict | None = None,
    compactor_state: dict | None = None,
) -> Path:
    """同 save_session_state，但写入路径基于 (uid, sid)。"""
    serialized_messages = serialize_messages(messages)
    new_count = len(serialized_messages)

    meta_file = config.meta_file_by_uid(user_id, session_id)
    messages_file = config.messages_file_by_uid(user_id, session_id)

    old_count = 0
    if meta_file.exists():
        try:
            with open(meta_file, encoding="utf-8") as f:
                old_count = json.load(f).get("message_count", 0)
        except (json.JSONDecodeError, OSError):
            old_count = 0

    new_lines = [json.dumps(msg, ensure_ascii=False) for msg in serialized_messages]
    if new_count > old_count > 0 and messages_file.exists():
        with open(messages_file, "a", encoding="utf-8") as f:
            for line in new_lines[old_count:]:
                f.write(line + "\n")
    else:
        _atomic_write_lines(messages_file, new_lines)

    meta = {
        "version": STATE_VERSION,
        "session_id": session_id,
        "user_id": user_id,
        "title": extract_title_from_messages(messages),
        "model": model,
        "caller_system_prompt": caller_system_prompt,
        "max_turns": max_turns,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "created_at": (created_at or datetime.now(timezone.utc)).isoformat(),
        "last_active": (last_active or datetime.now(timezone.utc)).isoformat(),
        "suspended_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "pending_question": pending_question,
        "pending_options": pending_options,
        "pending_permission_request": pending_permission_request,
        "compactor_state": compactor_state,
        "message_count": new_count,
    }
    _atomic_write_json(meta_file, meta)
    logger.info(
        "保存 session 状态: {}/{} ({} 条消息, 追加 {})",
        user_id,
        session_id,
        new_count,
        max(0, new_count - old_count),
    )
    return meta_file


def load_session_state_uid(config: SandboxConfig, user_id: str, session_id: str) -> dict | None:
    meta_file = config.meta_file_by_uid(user_id, session_id)
    messages_file = config.messages_file_by_uid(user_id, session_id)
    if not meta_file.exists():
        return None
    try:
        with open(meta_file, encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.error("加载 meta.json 失败: {}/{} - {}", user_id, session_id, e)
        return None

    raw_messages = []
    if messages_file.exists():
        try:
            with open(messages_file, encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        raw_messages.append(json.loads(stripped))
                    except json.JSONDecodeError:
                        logger.warning(
                            "messages.jsonl 第 {} 行解析失败: {}/{}",
                            line_num,
                            user_id,
                            session_id,
                        )
        except OSError as e:
            logger.error("加载 messages.jsonl 失败: {}/{} - {}", user_id, session_id, e)
    state["messages"] = [deserialize_message(item) for item in raw_messages]
    logger.info(
        "加载 session 状态: {}/{} ({} 条消息)",
        user_id,
        session_id,
        len(state["messages"]),
    )
    return state


def delete_session_state_uid(config: SandboxConfig, user_id: str, session_id: str) -> bool:
    """删除某 user 下指定 session 的所有状态文件（目录级别清理）"""
    session_dir = config.session_dir_by_uid(user_id, session_id)
    if session_dir.exists():
        shutil.rmtree(session_dir)
        logger.info("删除 session 状态: {}/{}", user_id, session_id)
        return True
    return False


def get_suspended_session_info_uid(config: SandboxConfig, user_id: str, session_id: str) -> dict | None:
    meta_file = config.meta_file_by_uid(user_id, session_id)
    if not meta_file.exists():
        return None
    try:
        with open(meta_file, encoding="utf-8") as f:
            meta = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    return {
        "session_id": meta.get("session_id", session_id),
        "user_id": meta.get("user_id", user_id),
        "title": meta.get("title", ""),
        "model": meta.get("model", ""),
        "max_turns": meta.get("max_turns", 10),
        "message_count": meta.get("message_count", 0),
        "total_input_tokens": meta.get("total_input_tokens", 0),
        "total_output_tokens": meta.get("total_output_tokens", 0),
        "created_at": meta.get("created_at", ""),
        "last_active": meta.get("last_active", ""),
        "suspended_at": meta.get("suspended_at", ""),
    }
