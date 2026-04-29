"""会话状态持久化 — 分层存储

按 (user_id, session_id) 维度把 session 状态落盘：
- meta.json:      会话元数据、配置、状态（极小，频繁全量重写无压力）
- messages.jsonl: 对话历史（增量追加，避免全量重写）
"""

import hashlib
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


def _message_fingerprint(serialized_msg: dict) -> tuple[str, str, str]:
    """给已序列化的 message 算一个 (role, type, content_hash8) 指纹。

    ``content_hash8`` 用 sha1 前 8 字符——足够区分不同 message、短到日志里肉眼可比。
    只在 save_session_state 里用作诊断：定位"同一 user prompt 在 messages.jsonl
    被连续追加多次"这类 prompt 重复注入问题。
    """
    role = serialized_msg.get("role") or ""
    mtype = serialized_msg.get("type") or ""
    # 直接对整条 message 的稳定 JSON 做 hash，避免踩 content 是 str/list/dict
    # 多种形态导致的分支逻辑。
    try:
        canonical = json.dumps(serialized_msg, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        canonical = repr(serialized_msg)
    h = hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:8]
    return role, mtype, h


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
    user_id: str,
    session_id: str,
    *,
    messages: list,
    model: str,
    caller_system_prompt: str | None,
    max_turns: int,
    model_messages: list | None = None,
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

    meta_file = config.meta_file(user_id, session_id)
    messages_file = config.messages_file(user_id, session_id)
    model_messages_file = config.model_messages_file(user_id, session_id)

    old_count = 0
    if meta_file.exists():
        try:
            with open(meta_file, encoding="utf-8") as f:
                old_count = json.load(f).get("message_count", 0)
        except (json.JSONDecodeError, OSError):
            old_count = 0

    new_lines = [json.dumps(msg, ensure_ascii=False) for msg in serialized_messages]
    if new_count > old_count > 0 and messages_file.exists():
        # 增量追加路径：诊断"prompt 重复注入" bug 的主要现场。
        # 1) 给追加的每条消息算指纹；
        # 2) 对比历史最后 K 条指纹，若本批追加的新消息指纹命中历史，上报 warning——
        #    真要是 LLM 输出偶然撞了某条旧消息的概率极低，更可能是 agent_loop
        #    在异步 tool 阻塞后把上一轮 user prompt 又塞了一遍。
        appended_serialized = serialized_messages[old_count:]
        appended_fps = [_message_fingerprint(m) for m in appended_serialized]

        recent_history_fps: list[tuple[str, str, str]] = []
        history_peek = 20
        if old_count > 0:
            try:
                with open(messages_file, encoding="utf-8") as f:
                    tail = f.readlines()[-history_peek:]
                for raw in tail:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        recent_history_fps.append(_message_fingerprint(json.loads(raw)))
                    except json.JSONDecodeError:
                        continue
            except OSError as e:
                logger.debug("诊断读取 messages.jsonl 尾部失败: {}", e)

        history_hashes = {fp[2] for fp in recent_history_fps}
        duplicates = [fp for fp in appended_fps if fp[2] in history_hashes]

        with open(messages_file, "a", encoding="utf-8") as f:
            for line in new_lines[old_count:]:
                f.write(line + "\n")

        # 常规诊断日志（debug 级）：每次追加都记录 role/type/hash 序列
        logger.debug(
            "append messages[{}]: {}/{} prev={} next={} fps={}",
            new_count - old_count,
            user_id,
            session_id,
            old_count,
            new_count,
            [f"{r}:{t}:{h}" for r, t, h in appended_fps],
        )
        # 疑似重复注入时升到 warning——方便线上直接用 grep 抓
        if duplicates:
            logger.warning(
                "疑似 prompt 重复注入 {}/{}：本次追加 {} 条里有 {} 条指纹命中历史最后"
                " {} 条。追加={} 命中={}。若频繁出现说明 agent_loop 某处在 async tool"
                " 阻塞后重复入队 user prompt。",
                user_id,
                session_id,
                len(appended_fps),
                len(duplicates),
                history_peek,
                [f"{r}:{t}:{h}" for r, t, h in appended_fps],
                [f"{r}:{t}:{h}" for r, t, h in duplicates],
            )
    else:
        _atomic_write_lines(messages_file, new_lines)
        logger.debug(
            "full-rewrite messages: {}/{} old={} new={} (trim/first-write)",
            user_id,
            session_id,
            old_count,
            new_count,
        )

    serialized_model_messages = serialize_messages(model_messages or messages)
    model_lines = [json.dumps(msg, ensure_ascii=False) for msg in serialized_model_messages]
    _atomic_write_lines(model_messages_file, model_lines)

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
        "model_message_count": len(serialized_model_messages),
    }
    _atomic_write_json(meta_file, meta)
    logger.info(
        "event=session.persist target_user={} target_session={} messages={} appended={}",
        user_id,
        session_id,
        new_count,
        max(0, new_count - old_count),
    )
    return meta_file


def load_session_state(config: SandboxConfig, user_id: str, session_id: str) -> dict | None:
    """从磁盘加载 session 状态（meta.json + messages.jsonl）"""
    meta_file = config.meta_file(user_id, session_id)
    messages_file = config.messages_file(user_id, session_id)
    model_messages_file = config.model_messages_file(user_id, session_id)
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
    raw_model_messages = []
    if model_messages_file.exists():
        try:
            with open(model_messages_file, encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        raw_model_messages.append(json.loads(stripped))
                    except json.JSONDecodeError:
                        logger.warning(
                            "model_messages.jsonl 第 {} 行解析失败: {}/{}",
                            line_num,
                            user_id,
                            session_id,
                        )
        except OSError as e:
            logger.error("加载 model_messages.jsonl 失败: {}/{} - {}", user_id, session_id, e)
    state["model_messages"] = [deserialize_message(item) for item in raw_model_messages] if raw_model_messages else []
    logger.info(
        "event=session.load target_user={} target_session={} messages={} model_messages={}",
        user_id,
        session_id,
        len(state["messages"]),
        len(state["model_messages"]),
    )
    return state


def delete_session_state(config: SandboxConfig, user_id: str, session_id: str) -> bool:
    """删除某 user 下指定 session 的所有状态文件（目录级别清理）"""
    session_dir = config.session_dir(user_id, session_id)
    if session_dir.exists():
        shutil.rmtree(session_dir)
        logger.info("删除 session 状态: {}/{}", user_id, session_id)
        return True
    return False


def get_suspended_session_info(config: SandboxConfig, user_id: str, session_id: str) -> dict | None:
    """获取已挂起 session 的摘要信息（只读 meta.json，不解析消息）"""
    meta_file = config.meta_file(user_id, session_id)
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
        "source": meta.get("source", "chat"),
        "hidden_from_session_list": meta.get("hidden_from_session_list", False),
    }
