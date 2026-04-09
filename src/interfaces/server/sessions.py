"""Session 管理器 — 内存存储 + TTL 自动清理"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ripple.api.client import OpenRouterClient
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.agent_tool import AgentTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
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


def _build_system_prompt() -> str:
    """构建 Server 模式的系统提示"""
    from ripple.skills.loader import get_global_loader

    loader = get_global_loader()
    skills = loader.list_skills()

    skills_info = []
    for skill in skills:
        desc = skill.description[:150] + "..." if len(skill.description) > 150 else skill.description
        skills_info.append(f"- {skill.name}: {desc}")

    skills_text = "\n".join(skills_info)
    workspace_dir = Path.cwd() / ".ripple" / "workspace"

    now_str = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    return f"""Today's date is {now_str}.

## File Writing Rules
When the user asks to write or save content to a file without specifying an explicit path:
- Default output directory: `{workspace_dir}`

# Available Skills
{skills_text}

IMPORTANT: Before declining a user request because it's outside your domain, check if there's a relevant skill available."""


def _create_session_context(model: str, session_id: str) -> tuple[ToolUseContext, OpenRouterClient]:
    """为一个 session 创建工具上下文和 API 客户端"""
    messages: list = []
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SearchTool(),
        AgentTool(messages=messages),
        SkillTool(),
    ]

    permission_manager = PermissionManager(mode=PermissionMode.ALLOW_ALL)

    context = ToolUseContext(
        options=ToolOptions(tools=tools, model=model),
        session_id=session_id,
        cwd=Path.cwd(),
        permission_manager=permission_manager,
        is_server_mode=True,
    )

    client = OpenRouterClient()
    return context, client


class SessionManager:
    """管理多客户端会话"""

    def __init__(self):
        config = get_config()
        self._sessions: dict[str, Session] = {}
        self._ttl_seconds: int = config.get("server.session.ttl_seconds", 3600)
        self._max_sessions: int = config.get("server.session.max_sessions", 100)
        self._cleanup_task: asyncio.Task | None = None

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
            self.cleanup_expired()

    def cleanup_expired(self):
        now = datetime.now(timezone.utc)
        expired = [
            sid for sid, s in self._sessions.items() if (now - s.last_active).total_seconds() > self._ttl_seconds
        ]
        for sid in expired:
            logger.info("Session 过期清理: {}", sid)
            del self._sessions[sid]

    def create_session(
        self,
        model: str | None = None,
        max_turns: int | None = None,
        system_prompt: str | None = None,
    ) -> Session:
        if len(self._sessions) >= self._max_sessions:
            self.cleanup_expired()
            if len(self._sessions) >= self._max_sessions:
                oldest = min(self._sessions.values(), key=lambda s: s.last_active)
                logger.warning("Session 数量达到上限，淘汰最旧的 session: {}", oldest.session_id)
                del self._sessions[oldest.session_id]

        config = get_config()
        resolved_model = config.resolve_model(model or config.get("model.default", "sonnet"))
        resolved_max_turns = max_turns or config.get("agent.max_turns", 10)

        session_id = f"srv-{uuid4().hex[:12]}"
        internal_sid = generate_session_id()

        context, client = _create_session_context(resolved_model, internal_sid)

        session = Session(
            session_id=session_id,
            context=context,
            client=client,
            model=resolved_model,
            system_prompt=system_prompt or _build_system_prompt(),
            max_turns=resolved_max_turns,
        )
        self._sessions[session_id] = session
        logger.info("创建 session: {} (model={})", session_id, resolved_model)
        return session

    def get_session(self, session_id: str) -> Session | None:
        session = self._sessions.get(session_id)
        if session:
            session.last_active = datetime.now(timezone.utc)
        return session

    def delete_session(self, session_id: str) -> bool:
        if session_id in self._sessions:
            session = self._sessions[session_id]
            if session.current_task and not session.current_task.done():
                session.current_task.cancel()
            del self._sessions[session_id]
            logger.info("删除 session: {}", session_id)
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

    def list_sessions(self) -> list[Session]:
        return list(self._sessions.values())

    def get_or_create_session(
        self,
        session_id: str | None,
        model: str | None = None,
        max_turns: int | None = None,
    ) -> tuple[Session, bool]:
        """获取已有 session 或创建新的。返回 (session, is_new)。"""
        if session_id:
            existing = self.get_session(session_id)
            if existing:
                return existing, False

        session = self.create_session(model=model, max_turns=max_turns)
        return session, True
