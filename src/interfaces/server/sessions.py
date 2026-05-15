"""Session 管理器 — 沙箱隔离 + 内存/磁盘混合存储 + TTL 自动清理 + 挂起/恢复"""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from interfaces.server.schemas import FeishuConfig

from ripple.core.context import AbortSignal, ToolOptions, ToolUseContext
from ripple.sandbox.manager import SandboxManager
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger
from ripple.utils.logger import logger as root_logger
from ripple.utils.time import current_time_context

logger = get_logger("server.sessions")


class SessionStatus:
    """Session 运行状态"""

    IDLE = "idle"
    RUNNING = "running"
    AWAITING_USER_INPUT = "awaiting_user_input"
    AWAITING_PERMISSION = "awaiting_permission"


@dataclass
class Session:
    session_id: str
    user_id: str = "default"
    messages: list = field(default_factory=list)
    model_messages: list = field(default_factory=list)
    context: ToolUseContext | None = None
    model: str = ""
    caller_system_prompt: str | None = None
    max_turns: int = 10
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_active: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    current_task: asyncio.Task | None = None
    last_input_tokens: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    status: str = SessionStatus.IDLE
    pending_question: str | None = None
    pending_options: list[str] | None = None
    pending_permission_request: dict[str, object] | None = None


def _build_default_system_prompt(workspace_dir: Path | None = None) -> str:
    """Build the Codex-only default system prompt for server sessions."""
    return f"""{current_time_context()}

## Ripple Control Plane
Ripple manages user identity, session lifecycle, sandbox isolation, connector authorization, credential injection, job state, and API boundaries.

## Codex Execution Plane
Codex app-server is the only execution plane. Do the actual work inside the current user's `/workspace` sandbox. Read files, write files, run commands, search, and use connector CLIs from Codex itself rather than asking Ripple to execute tools.

## Workspace
- The sandbox working directory is `/workspace`.
- Use `/workspace/...` or relative paths for user files.
- User-installed skills live under `/workspace/skills/`.
- Shared public skills are mounted read-only under `/opt/ripple/skills/shared/`.

## Connectors And Skills
Ripple injects connector credentials and exposes connector status in each Codex prompt. Skills are listed as a manifest with sandbox-visible paths; read the relevant `SKILL.md` and its local resources directly when useful.

## Approvals
If Codex needs user approval, request it through the Codex app-server approval flow. Ripple will surface the pending approval to the user and forward the user's decision back to Codex.

## Scheduling
Ripple does not provide an embedded scheduler. Future or recurring work should be handled by an external scheduler that calls `/v1/runs` with the correct `X-Ripple-User-Id`."""


_CALLER_PROMPT_SEPARATOR = (
    "\n\n"
    "────────────────────────────────────────────────────────\n"
    "# Caller Instructions (HIGHEST PRIORITY)\n\n"
    "The following instructions are provided by the calling application and "
    "**take precedence over any conflicting rules above**. If there is any "
    "conflict between these instructions and the sections above (output format, "
    "tool usage, planning, interaction style, etc.), you MUST follow the rules "
    "in this section.\n\n"
)


def _merge_system_prompt(workspace_dir: Path | None, caller_system_prompt: str | None) -> str:
    """将默认 prompt 与调用方追加的 caller prompt 合并

    每次请求都会调用，以便刷新默认 prompt 中的日期和 skill 列表。
    """
    default_prompt = _build_default_system_prompt(workspace_dir)
    if not caller_system_prompt or not caller_system_prompt.strip():
        return default_prompt
    return default_prompt + _CALLER_PROMPT_SEPARATOR + caller_system_prompt.strip()


_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def _validate_session_id(session_id: str) -> None:
    """校验 session_id 合法性，防止路径穿越"""
    if not _SESSION_ID_RE.match(session_id):
        raise ValueError(f"Invalid session_id: {session_id!r}")


def _get_server_tools() -> list:
    """Return model-facing Ripple tools.

    Codex app-server is now the only execution plane. Ripple keeps this helper
    as a compatibility point for `/v1/info` and session context construction.
    """
    return []


def get_server_tool_names() -> list[str]:
    """返回 Server 模式可用的工具名列表（供 /v1/info 使用）"""
    return [t.name for t in _get_server_tools()]


def _create_session_context(
    model: str,
    session_id: str,
    *,
    provider: str | None = None,
    reasoning_effort: str | None = None,
    workspace_root: Path | None = None,
    sandbox_session_id: str | None = None,
    session_runtime_dir: Path | None = None,
    user_id: str | None = None,
    sandbox_manager: SandboxManager | None = None,
) -> ToolUseContext:
    """为一个 session 创建工具上下文"""
    tools = _get_server_tools()

    cwd = workspace_root if workspace_root else Path.cwd()

    context = ToolUseContext(
        options=ToolOptions(tools=tools, model=model, provider=provider, reasoning_effort=reasoning_effort),
        session_id=session_id,
        cwd=cwd,
        abort_signal=AbortSignal(),
        permission_manager=None,
        workspace_root=workspace_root,
        sandbox_session_id=sandbox_session_id,
        session_runtime_dir=session_runtime_dir,
        user_id=user_id,
        sandbox_manager=sandbox_manager,
        sandboxed=workspace_root is not None and sandbox_manager is not None,
    )

    return context


class SessionManager:
    """管理多客户端会话（集成沙箱隔离）"""

    def __init__(self, sandbox_manager: SandboxManager | None = None):
        config = get_config()
        self._sessions: dict[tuple[str, str], Session] = {}
        self._ttl_seconds: int = config.get("server.session.ttl_seconds", 3600)
        self._cleanup_task: asyncio.Task | None = None
        self._sandbox_manager = sandbox_manager

    @property
    def sandbox_manager(self) -> SandboxManager | None:
        return self._sandbox_manager

    def start_cleanup_loop(self):
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    def stop_cleanup_loop(self):
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None

    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(60)
            self._cleanup_expired()

    def _cleanup_expired(self):
        """清理过期 session：先挂起，再根据保留策略删除

        后台任务内的日志在这里显式绑定 user_id/session_id，避免落盘成 "-"。
        """
        now = datetime.now(timezone.utc)
        expired = [
            key for key, s in self._sessions.items() if (now - s.last_active).total_seconds() > self._ttl_seconds
        ]
        for key in expired:
            session = self._sessions[key]
            with root_logger.contextualize(user_id=key[0], session_id=key[1], request_id="cleanup"):
                if self._sandbox_manager:
                    if session.current_task and not session.current_task.done():
                        session.current_task.cancel()
                    self._suspend_to_disk(session)
                    logger.info("Session 过期自动挂起")
                else:
                    logger.info("Session 过期清理")
            del self._sessions[key]

        # 清理磁盘上过期的挂起 session
        if self._sandbox_manager:
            self._sandbox_manager.cleanup_expired_suspended()

    def _suspend_to_disk(self, session: Session):
        """内部方法：将 session 状态保存到磁盘"""
        if not self._sandbox_manager:
            return
        self._sandbox_manager.suspend_session(
            session.user_id,
            session.session_id,
            messages=session.messages,
            model_messages=session.model_messages,
            model=session.model,
            caller_system_prompt=session.caller_system_prompt,
            max_turns=session.max_turns,
            total_input_tokens=session.total_input_tokens,
            total_output_tokens=session.total_output_tokens,
            created_at=session.created_at,
            last_active=session.last_active,
            status=session.status,
            pending_question=session.pending_question,
            pending_options=session.pending_options,
            pending_permission_request=session.pending_permission_request,
        )

    def _write_feishu_config(self, user_id: str, feishu: "FeishuConfig") -> None:
        """将飞书凭证写入 user 目录的 feishu.json"""
        import json

        if not self._sandbox_manager:
            return
        feishu_file = self._sandbox_manager.config.feishu_config_file(user_id)
        feishu_file.parent.mkdir(parents=True, exist_ok=True)
        feishu_file.write_text(
            json.dumps({"app_id": feishu.app_id, "app_secret": feishu.app_secret, "brand": feishu.brand}, indent=2),
            encoding="utf-8",
        )
        feishu_file.chmod(0o600)
        logger.debug("写入 user {} feishu.json", user_id)

    def create_session(
        self,
        *,
        user_id: str = "default",
        model: str | None = None,
        max_turns: int | None = None,
        caller_system_prompt: str | None = None,
        feishu: "FeishuConfig | None" = None,
    ) -> Session:
        config = get_config()
        selected_model = model or config.get("model.default", "codex-medium")
        resolved = config.resolve_model_info(selected_model)
        resolved_model = resolved.model
        resolved_max_turns = max_turns or config.get("agent.max_turns", 10)

        session_id = f"srv-{uuid4().hex[:12]}"
        internal_sid = uuid4().hex[:12]

        # 沙箱初始化
        workspace_root = None
        session_runtime_dir = None
        if self._sandbox_manager:
            self._sandbox_manager.ensure_sandbox(user_id)
            self._sandbox_manager.setup_session(user_id, session_id)
            workspace_root = self._sandbox_manager.config.workspace_dir(user_id)
            session_runtime_dir = self._sandbox_manager.config.session_dir(user_id, session_id)
            if feishu:
                self._write_feishu_config(user_id, feishu)

        context = _create_session_context(
            resolved_model,
            internal_sid,
            provider=resolved.provider,
            reasoning_effort=resolved.reasoning_effort,
            workspace_root=workspace_root,
            sandbox_session_id=session_id if self._sandbox_manager else None,
            session_runtime_dir=session_runtime_dir,
            user_id=user_id,
            sandbox_manager=self._sandbox_manager,
        )

        session = Session(
            session_id=session_id,
            user_id=user_id,
            context=context,
            model=selected_model,
            caller_system_prompt=caller_system_prompt,
            max_turns=resolved_max_turns,
        )
        self._sessions[(user_id, session_id)] = session
        logger.info(
            "event=session.create target_user={} target_session={} model={} resolved_model={} workspace={}",
            user_id,
            session_id,
            selected_model,
            resolved_model,
            workspace_root or "none",
        )
        return session

    def configure_session_model(self, session: Session, model: str | None) -> str:
        """Apply a user-facing model choice to an existing session.

        `Session.model` preserves the selection that the UI/API sent, while
        `context.options.model` stores the raw provider model ID used by the
        Codex execution plane. Conversation and tool state remain intact.
        """
        config = get_config()
        selected_model = model or session.model or config.get("model.default", "codex-medium")
        resolved = config.resolve_model_info(selected_model)

        if session.context is not None:
            session.context.options.model = resolved.model
            session.context.options.provider = resolved.provider
            session.context.options.reasoning_effort = resolved.reasoning_effort

        session.model = selected_model
        return resolved.model

    def get_session(self, session_id: str, *, user_id: str = "default") -> Session | None:
        return self._sessions.get((user_id, session_id))

    def touch_session(self, session: Session) -> None:
        """Mark a session as active because real conversation state changed."""
        if session:
            session.last_active = datetime.now(timezone.utc)

    def delete_session(self, session_id: str, *, user_id: str = "default") -> bool:
        _validate_session_id(session_id)
        key = (user_id, session_id)
        if key in self._sessions:
            session = self._sessions[key]
            if session.current_task and not session.current_task.done():
                session.current_task.cancel()

            del self._sessions[key]

            # 清理沙箱（包括磁盘文件）
            if self._sandbox_manager:
                self._sandbox_manager.teardown_session(user_id, session_id)

            logger.info("删除 session: {}/{}", user_id, session_id)
            return True

        # 可能是已挂起的 session
        if self._sandbox_manager:
            self._sandbox_manager.teardown_session(user_id, session_id)
            return True

        return False

    def stop_session(self, session_id: str, *, user_id: str = "default") -> bool:
        """停止 session 中正在运行的任务"""
        session = self.get_session(session_id, user_id=user_id)
        if session:
            if session.current_task and not session.current_task.done():
                if session.context and session.context.abort_signal:
                    session.context.abort_signal.abort()
                session.current_task.cancel()
                logger.info("已停止 session 的当前任务: {}/{}", user_id, session_id)
                return True
            else:
                logger.info("session {}/{} 没有正在运行的任务", user_id, session_id)
                return False
        return False

    def suspend_session(self, session_id: str, *, user_id: str = "default") -> bool:
        """手动挂起 session：从内存移除，状态持久化到磁盘"""
        _validate_session_id(session_id)
        key = (user_id, session_id)
        session = self._sessions.get(key)
        if not session:
            return False

        if session.current_task and not session.current_task.done():
            session.current_task.cancel()

        self._suspend_to_disk(session)
        del self._sessions[key]
        logger.info("手动挂起 session: {}/{}", user_id, session_id)
        return True

    def resume_session(
        self,
        session_id: str,
        *,
        user_id: str = "default",
    ) -> Session | None:
        """从磁盘恢复已挂起的 session 到内存"""
        _validate_session_id(session_id)
        key = (user_id, session_id)
        if key in self._sessions:
            return self._sessions[key]

        if not self._sandbox_manager:
            return None

        state = self._sandbox_manager.resume_session(user_id, session_id)
        if state is None:
            return None

        config = get_config()
        selected_model = state.get("model", config.get("model.default", "codex-medium"))
        resolved = config.resolve_model_info(selected_model)
        resolved_model = resolved.model
        workspace_root = self._sandbox_manager.config.workspace_dir(user_id)
        if not workspace_root.exists():
            workspace_root = None
        session_runtime_dir = self._sandbox_manager.config.session_dir(user_id, session_id)

        internal_sid = uuid4().hex[:12]
        context = _create_session_context(
            resolved_model,
            internal_sid,
            provider=resolved.provider,
            reasoning_effort=resolved.reasoning_effort,
            workspace_root=workspace_root,
            sandbox_session_id=session_id,
            session_runtime_dir=session_runtime_dir,
            user_id=user_id,
            sandbox_manager=self._sandbox_manager,
        )

        created_at = datetime.now(timezone.utc)
        if state.get("created_at"):
            try:
                created_at = datetime.fromisoformat(state["created_at"])
            except (ValueError, TypeError):
                pass
        last_active = created_at
        if state.get("last_active"):
            try:
                last_active = datetime.fromisoformat(state["last_active"])
            except (ValueError, TypeError):
                pass

        session = Session(
            session_id=session_id,
            user_id=user_id,
            messages=state.get("messages", []),
            model_messages=state.get("model_messages", []),
            context=context,
            model=selected_model,
            caller_system_prompt=state.get("caller_system_prompt"),
            max_turns=state.get("max_turns", 10),
            created_at=created_at,
            last_active=last_active,
            total_input_tokens=state.get("total_input_tokens", 0),
            total_output_tokens=state.get("total_output_tokens", 0),
            status=state.get("status", SessionStatus.IDLE),
            pending_question=state.get("pending_question"),
            pending_options=state.get("pending_options"),
            pending_permission_request=state.get("pending_permission_request"),
        )
        self._sessions[key] = session
        logger.info(
            "event=session.resume target_user={} target_session={} messages={}",
            user_id,
            session_id,
            len(session.messages),
        )
        return session

    def persist_session(self, session: Session) -> bool:
        """将 session 当前状态持久化到磁盘（不从内存中移除）

        直接接收 Session 实例以避免调用方忘传 user_id 导致的落盘失败。
        """
        if not self._sandbox_manager:
            return False
        self._suspend_to_disk(session)
        return True

    def list_sessions(self, *, user_id: str | None = None) -> list[Session]:
        if user_id is None:
            return list(self._sessions.values())
        return [s for s in self._sessions.values() if s.user_id == user_id]

    def list_all_sessions(self, *, user_id: str | None = None) -> list[dict]:
        """列出所有 session（内存活跃 + 磁盘持久化），去重后按 last_active 降序"""
        from ripple.sandbox.storage import extract_title_from_messages, get_suspended_session_info

        if not self._sandbox_manager:
            user_ids_to_scan: list[str] = []
        elif user_id is not None:
            user_ids_to_scan = [user_id]
        else:
            user_ids_to_scan = self._sandbox_manager.list_user_sandboxes()

        result: dict[tuple[str, str], dict] = {}

        for uid in user_ids_to_scan:
            for sid in self._sandbox_manager.list_user_sessions(uid):
                info = get_suspended_session_info(self._sandbox_manager.config, uid, sid)
                if self._is_hidden_session_info(info):
                    continue
                if info and info.get("message_count", 0) > 0:
                    info["status"] = "suspended"
                    info["user_id"] = uid
                    result[(uid, sid)] = info

        for s in self._sessions.values():
            if user_id is not None and s.user_id != user_id:
                continue
            if not s.messages:
                continue
            result[(s.user_id, s.session_id)] = {
                "session_id": s.session_id,
                "user_id": s.user_id,
                "title": extract_title_from_messages(s.messages),
                "model": s.model,
                "message_count": len(s.messages),
                "created_at": s.created_at.isoformat(),
                "last_active": s.last_active.isoformat(),
                "status": s.status,
                "total_input_tokens": s.total_input_tokens,
                "total_output_tokens": s.total_output_tokens,
            }

        return sorted(result.values(), key=lambda x: x.get("last_active", ""), reverse=True)

    def _is_hidden_session_info(self, info: dict | None) -> bool:
        if info is None:
            return False
        return bool(info.get("hidden_from_session_list")) or info.get("source") == "scheduler"

    def list_suspended_sessions(self, *, user_id: str | None = None) -> list[dict]:
        """列出所有已挂起（仅在磁盘上）的 session"""
        from ripple.sandbox.storage import get_suspended_session_info

        if not self._sandbox_manager:
            return []
        user_ids_to_scan = [user_id] if user_id is not None else self._sandbox_manager.list_user_sandboxes()
        active_keys = {(s.user_id, s.session_id) for s in self._sessions.values()}
        out: list[dict] = []
        for uid in user_ids_to_scan:
            for sid in self._sandbox_manager.list_user_sessions(uid):
                if (uid, sid) in active_keys:
                    continue
                info = get_suspended_session_info(self._sandbox_manager.config, uid, sid)
                if self._is_hidden_session_info(info):
                    continue
                if info:
                    info["user_id"] = uid
                    out.append(info)
        return out

    def get_or_create_session(
        self,
        session_id: str | None,
        *,
        user_id: str = "default",
        model: str | None = None,
        max_turns: int | None = None,
        caller_system_prompt: str | None = None,
    ) -> tuple[Session, bool]:
        """获取已有 session 或创建新的。支持自动恢复已挂起的 session。"""
        if session_id:
            _validate_session_id(session_id)
            existing = self.get_session(session_id, user_id=user_id)
            if existing:
                return existing, False

            # 尝试从磁盘恢复
            resumed = self.resume_session(session_id, user_id=user_id)
            if resumed:
                return resumed, False

        session = self.create_session(
            user_id=user_id,
            model=model,
            max_turns=max_turns,
            caller_system_prompt=caller_system_prompt,
        )
        return session, True
