"""Session 管理器 — 沙箱隔离 + 内存/磁盘混合存储 + TTL 自动清理 + 挂起/恢复"""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ripple.api.client import OpenRouterClient
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.sandbox.manager import SandboxManager
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.agent_tool import AgentTool
from ripple.tools.builtin.ask_user import AskUserTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
from ripple.tools.builtin.task_create import TaskCreateTool
from ripple.tools.builtin.task_get import TaskGetTool
from ripple.tools.builtin.task_list import TaskListTool
from ripple.tools.builtin.task_update import TaskUpdateTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config
from ripple.utils.conversation_log import generate_session_id
from ripple.utils.logger import get_logger

logger = get_logger("server.sessions")


@dataclass
class Session:
    session_id: str
    messages: list = field(default_factory=list)
    context: ToolUseContext | None = None
    client: OpenRouterClient | None = None
    model: str = ""
    system_prompt: str | None = None
    max_turns: int = 10
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_active: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    current_task: asyncio.Task | None = None
    last_input_tokens: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0

    def trim_messages_if_needed(self, max_tokens: int = 150_000) -> int:
        """当消息历史过长时修剪，参考 CLI 的 trim 策略。

        Returns:
            被修剪的消息数量
        """
        from ripple.messages.cleanup import estimate_tokens
        from ripple.messages.utils import normalize_messages_for_api

        normalized = normalize_messages_for_api(self.messages)
        token_count = self.last_input_tokens or estimate_tokens(normalized)
        if token_count < max_tokens:
            return 0

        old_count = len(self.messages)
        keep_count = int(old_count * 0.8)
        if keep_count < 2:
            keep_count = 2
        self.messages = self.messages[-keep_count:]
        trimmed = old_count - len(self.messages)
        logger.info("Session {} 消息修剪: 移除 {} 条旧消息 (tokens≈{})", self.session_id, trimmed, token_count)
        return trimmed


def _build_system_prompt(workspace_dir: Path | None = None) -> str:
    """构建 Server 模式的系统提示"""
    from ripple.skills.loader import get_global_loader

    loader = get_global_loader()
    skills = loader.list_skills()

    skills_info = []
    for skill in skills:
        desc = skill.description[:150] + "..." if len(skill.description) > 150 else skill.description
        skills_info.append(f"- {skill.name}: {desc}")

    skills_text = "\n".join(skills_info)

    now_str = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    return f"""Today's date is {now_str}.

## Workspace
You are operating in a sandboxed workspace. Your working directory is `/workspace`.

### File Operations (Read, Write tools)
- Use paths like `/workspace/file.txt` or relative paths like `file.txt`
- Paths are automatically resolved relative to your workspace
- Do NOT construct absolute host paths — always use `/workspace/` prefix or relative paths

### Shell Commands (Bash tool)
- Your current directory is already `/workspace`
- Use relative paths in commands (e.g., `ls`, `cat file.txt`, `python script.py`)

### File Writing Rules
When the user asks to write or save content to a file without specifying an explicit path:
- Default output directory: `/workspace`

# Using your tools
- Do NOT use the Bash tool to read or write files when dedicated Read/Write tools are available. Using dedicated tools allows the user to better understand and review your work.
- Break down and manage your work with the TaskCreate tool. Use TaskCreate to plan your work and help the user track your progress. Mark each task as completed (via TaskUpdate) as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.
- You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially.

# Available Skills
{skills_text}

IMPORTANT: Before declining a user request because it's outside your domain, check if there's a relevant skill available."""


_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def _validate_session_id(session_id: str) -> None:
    """校验 session_id 合法性，防止路径穿越"""
    if not _SESSION_ID_RE.match(session_id):
        raise ValueError(f"Invalid session_id: {session_id!r}")


def _get_server_tools() -> list:
    """返回 Server 模式的工具实例列表（单一来源）"""
    return [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SearchTool(),
        AgentTool(),
        SkillTool(),
        AskUserTool(),
        TaskCreateTool(),
        TaskUpdateTool(),
        TaskListTool(),
        TaskGetTool(),
    ]


def get_server_tool_names() -> list[str]:
    """返回 Server 模式可用的工具名列表（供 /v1/info 使用）"""
    return [t.name for t in _get_server_tools()]


def _create_session_context(
    model: str,
    session_id: str,
    *,
    workspace_root: Path | None = None,
    sandbox_session_id: str | None = None,
) -> tuple[ToolUseContext, OpenRouterClient]:
    """为一个 session 创建工具上下文和 API 客户端"""
    tools = _get_server_tools()

    permission_manager = PermissionManager(mode=PermissionMode.ALLOW_ALL)

    cwd = workspace_root if workspace_root else Path.cwd()

    context = ToolUseContext(
        options=ToolOptions(tools=tools, model=model),
        session_id=session_id,
        cwd=cwd,
        permission_manager=permission_manager,
        is_server_mode=True,
        workspace_root=workspace_root,
        sandbox_session_id=sandbox_session_id,
    )

    client = OpenRouterClient()
    return context, client


class SessionManager:
    """管理多客户端会话（集成沙箱隔离）"""

    def __init__(self, sandbox_manager: SandboxManager | None = None):
        config = get_config()
        self._sessions: dict[str, Session] = {}
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
        """清理过期 session：先挂起，再根据保留策略删除"""
        now = datetime.now(timezone.utc)
        expired = [
            sid for sid, s in self._sessions.items() if (now - s.last_active).total_seconds() > self._ttl_seconds
        ]
        for sid in expired:
            if self._sandbox_manager:
                session = self._sessions[sid]
                if session.current_task and not session.current_task.done():
                    session.current_task.cancel()
                self._suspend_to_disk(session)
                logger.info("Session 过期自动挂起: {}", sid)
            else:
                logger.info("Session 过期清理: {}", sid)
            del self._sessions[sid]

        # 清理磁盘上过期的挂起 session
        if self._sandbox_manager:
            self._sandbox_manager.cleanup_expired_suspended()

    def _suspend_to_disk(self, session: Session):
        """内部方法：将 session 状态保存到磁盘"""
        if not self._sandbox_manager:
            return
        self._sandbox_manager.suspend_session(
            session.session_id,
            messages=session.messages,
            model=session.model,
            system_prompt=session.system_prompt,
            max_turns=session.max_turns,
            total_input_tokens=session.total_input_tokens,
            total_output_tokens=session.total_output_tokens,
            created_at=session.created_at,
            last_active=session.last_active,
        )

    def create_session(
        self,
        model: str | None = None,
        max_turns: int | None = None,
        system_prompt: str | None = None,
    ) -> Session:
        config = get_config()
        resolved_model = config.resolve_model(model or config.get("model.default", "sonnet"))
        resolved_max_turns = max_turns or config.get("agent.max_turns", 10)

        session_id = f"srv-{uuid4().hex[:12]}"
        internal_sid = generate_session_id()

        # 沙箱初始化
        workspace_root = None
        if self._sandbox_manager:
            workspace_root = self._sandbox_manager.setup_session(session_id)

        context, client = _create_session_context(
            resolved_model,
            internal_sid,
            workspace_root=workspace_root,
            sandbox_session_id=session_id if self._sandbox_manager else None,
        )

        session = Session(
            session_id=session_id,
            context=context,
            client=client,
            model=resolved_model,
            system_prompt=system_prompt or _build_system_prompt(workspace_root),
            max_turns=resolved_max_turns,
        )
        self._sessions[session_id] = session
        logger.info(
            "创建 session: {} (model={}, workspace={})",
            session_id,
            resolved_model,
            workspace_root or "none",
        )
        return session

    def get_session(self, session_id: str) -> Session | None:
        session = self._sessions.get(session_id)
        if session:
            session.last_active = datetime.now(timezone.utc)
        return session

    def delete_session(self, session_id: str) -> bool:
        _validate_session_id(session_id)
        if session_id in self._sessions:
            session = self._sessions[session_id]
            if session.current_task and not session.current_task.done():
                session.current_task.cancel()
            del self._sessions[session_id]

            # 清理沙箱（包括磁盘文件）
            if self._sandbox_manager:
                self._sandbox_manager.teardown_session(session_id)

            logger.info("删除 session: {}", session_id)
            return True

        # 可能是已挂起的 session
        if self._sandbox_manager:
            self._sandbox_manager.teardown_session(session_id)
            return True

        return False

    def stop_session(self, session_id: str) -> bool:
        """停止 session 中正在运行的任务"""
        session = self.get_session(session_id)
        if session:
            if session.current_task and not session.current_task.done():
                session.current_task.cancel()
                logger.info("已停止 session 的当前任务: {}", session_id)
                return True
            else:
                logger.info("session {} 没有正在运行的任务", session_id)
                return False
        return False

    def suspend_session(self, session_id: str) -> bool:
        """手动挂起 session：从内存移除，状态持久化到磁盘"""
        _validate_session_id(session_id)
        session = self._sessions.get(session_id)
        if not session:
            return False

        if session.current_task and not session.current_task.done():
            session.current_task.cancel()

        self._suspend_to_disk(session)
        del self._sessions[session_id]
        logger.info("手动挂起 session: {}", session_id)
        return True

    def resume_session(self, session_id: str) -> Session | None:
        """从磁盘恢复已挂起的 session 到内存"""
        _validate_session_id(session_id)
        if session_id in self._sessions:
            return self._sessions[session_id]

        if not self._sandbox_manager:
            return None

        state = self._sandbox_manager.resume_session(session_id)
        if state is None:
            return None

        config = get_config()
        resolved_model = config.resolve_model(state.get("model", config.get("model.default", "sonnet")))
        workspace_root = self._sandbox_manager.get_session_workspace(session_id)

        internal_sid = generate_session_id()
        context, client = _create_session_context(
            resolved_model,
            internal_sid,
            workspace_root=workspace_root,
            sandbox_session_id=session_id,
        )

        created_at = datetime.now(timezone.utc)
        if state.get("created_at"):
            try:
                created_at = datetime.fromisoformat(state["created_at"])
            except (ValueError, TypeError):
                pass

        session = Session(
            session_id=session_id,
            messages=state.get("messages", []),
            context=context,
            client=client,
            model=resolved_model,
            system_prompt=state.get("system_prompt") or _build_system_prompt(workspace_root),
            max_turns=state.get("max_turns", 10),
            created_at=created_at,
            total_input_tokens=state.get("total_input_tokens", 0),
            total_output_tokens=state.get("total_output_tokens", 0),
        )
        self._sessions[session_id] = session
        logger.info("恢复 session: {} ({} 条历史消息)", session_id, len(session.messages))
        return session

    def persist_session(self, session_id: str) -> bool:
        """将 session 当前状态持久化到磁盘（不从内存中移除）"""
        session = self._sessions.get(session_id)
        if not session or not self._sandbox_manager:
            return False
        self._suspend_to_disk(session)
        return True

    def list_sessions(self) -> list[Session]:
        return list(self._sessions.values())

    def list_all_sessions(self) -> list[dict]:
        """列出所有 session（内存活跃 + 磁盘持久化），去重后按 last_active 降序"""
        from ripple.sandbox.storage import extract_title_from_messages, get_suspended_session_info
        from ripple.sandbox.workspace import list_suspended_sessions as _list_disk_sessions

        result: dict[str, dict] = {}

        if self._sandbox_manager:
            for sid in _list_disk_sessions(self._sandbox_manager.config):
                info = get_suspended_session_info(self._sandbox_manager.config, sid)
                if info and info.get("message_count", 0) > 0:
                    info["status"] = "suspended"
                    result[sid] = info

        for s in self._sessions.values():
            if not s.messages:
                continue
            result[s.session_id] = {
                "session_id": s.session_id,
                "title": extract_title_from_messages(s.messages),
                "model": s.model,
                "message_count": len(s.messages),
                "created_at": s.created_at.isoformat(),
                "last_active": s.last_active.isoformat(),
                "status": "active",
                "total_input_tokens": s.total_input_tokens,
                "total_output_tokens": s.total_output_tokens,
            }

        return sorted(result.values(), key=lambda x: x.get("last_active", ""), reverse=True)

    def list_suspended_sessions(self) -> list[dict]:
        """列出所有已挂起（仅在磁盘上）的 session"""
        if not self._sandbox_manager:
            return []
        suspended = self._sandbox_manager.list_suspended()
        active_ids = set(self._sessions.keys())
        return [s for s in suspended if s["session_id"] not in active_ids]

    def get_or_create_session(
        self,
        session_id: str | None,
        model: str | None = None,
        max_turns: int | None = None,
    ) -> tuple[Session, bool]:
        """获取已有 session 或创建新的。支持自动恢复已挂起的 session。"""
        if session_id:
            _validate_session_id(session_id)
            existing = self.get_session(session_id)
            if existing:
                return existing, False

            # 尝试从磁盘恢复
            resumed = self.resume_session(session_id)
            if resumed:
                return resumed, False

        session = self.create_session(model=model, max_turns=max_turns)
        return session, True
