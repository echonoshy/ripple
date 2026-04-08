"""会话管理器：管理多个客户端会话"""

import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import WebSocket

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.agent_tool import AgentTool
from ripple.tools.builtin.ask_user import AskUserTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config


@dataclass
class Session:
    """会话状态"""

    session_id: str
    messages: list[dict] = field(default_factory=list)
    token_count: int = 0
    context: ToolUseContext | None = None
    permission_manager: PermissionManager | None = None
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)


class SessionManager:
    """管理多个客户端会话"""

    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._websocket_to_session: dict[WebSocket, str] = {}

    def create_session(self, websocket: WebSocket) -> Session:
        """创建新会话

        Args:
            websocket: WebSocket 连接

        Returns:
            新创建的会话
        """
        import uuid

        session_id = str(uuid.uuid4())

        # 加载配置
        config = get_config()
        raw_model = config.get("model.default", "anthropic/claude-3.5-sonnet")
        model = config.resolve_model(raw_model)

        # 初始化工具
        tools = [
            BashTool(),
            ReadTool(),
            WriteTool(),
            SearchTool(),
            AgentTool(messages=[]),
            SkillTool(),
            AskUserTool(),
        ]

        # 创建权限管理器
        permission_manager = PermissionManager(mode=PermissionMode.SMART)

        # 创建上下文
        context = ToolUseContext(
            options=ToolOptions(tools=tools, model=model),
            session_id=session_id,
            cwd=str(Path.cwd()),
            permission_manager=permission_manager,
        )

        session = Session(
            session_id=session_id,
            context=context,
            permission_manager=permission_manager,
        )

        self._sessions[session_id] = session
        self._websocket_to_session[websocket] = session_id

        return session

    def get_session(self, websocket: WebSocket) -> Session | None:
        """获取会话

        Args:
            websocket: WebSocket 连接

        Returns:
            会话或 None
        """
        session_id = self._websocket_to_session.get(websocket)
        if session_id:
            session = self._sessions.get(session_id)
            if session:
                session.last_active = time.time()
            return session
        return None

    def remove_session(self, websocket: WebSocket):
        """移除会话

        Args:
            websocket: WebSocket 连接
        """
        session_id = self._websocket_to_session.pop(websocket, None)
        if session_id:
            self._sessions.pop(session_id, None)
