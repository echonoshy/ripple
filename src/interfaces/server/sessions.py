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

from ripple.api.client import OpenRouterClient
from ripple.compact.context_manager import ContextManager
from ripple.core.context import AbortSignal, ToolOptions, ToolUseContext
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
from ripple.utils.conversation_log import ConversationLogger, generate_session_id
from ripple.utils.logger import get_logger

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
    messages: list = field(default_factory=list)
    context: ToolUseContext | None = None
    client: OpenRouterClient | None = None
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
    conversation_log: ConversationLogger | None = None
    context_manager: ContextManager | None = None


def _build_default_system_prompt(workspace_dir: Path | None = None) -> str:
    """构建 Server 模式的默认系统提示（每轮请求动态调用以刷新日期和 skill 列表）

    Server 模式下使用三层合并的 skill 列表（bundled + shared + workspace/skills/），
    无 workspace 时使用共享 skills（bundled + shared_dirs）。
    """
    if workspace_dir:
        from ripple.skills.loader import load_workspace_skills

        skills_dict = load_workspace_skills(workspace_dir)
        skills = list(skills_dict.values())
    else:
        from ripple.skills.loader import load_shared_skills

        skills_dict = load_shared_skills()
        skills = list(skills_dict.values())

    skills_info = []
    for skill in skills:
        desc = skill.description[:150] + "..." if len(skill.description) > 150 else skill.description
        skills_info.append(f"- {skill.name}: {desc}")

    skills_text = "\n".join(skills_info) if skills_info else "(no skills installed yet)"

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

### Development Environment
- This workspace is pre-configured with **Python** + **uv** and **Node.js** + **pnpm**.
- A Python virtual environment and pnpm global environment are automatically set up on first use.
- When the user asks to implement a feature, build a tool, write a script, do data analysis, create a web app, or any coding task, **always prefer Python** unless the user explicitly requests another language or the task clearly requires Node.js (e.g., installing npm packages, running frontend frameworks).
- If the user's request is language-agnostic (e.g., "帮我写一个爬虫", "做一个数据分析", "写一个 web 服务"), default to Python without asking.

### Python Package Management
- To install Python packages, use `uv pip install <package>` instead of `pip install` or `pip3 install`.
- Example: `uv pip install numpy pandas matplotlib`
- Do NOT use `pip install` or `pip3 install` directly — they may install packages to the wrong location.

### Node.js / pnpm Package Management
- **Always prefer `pnpm` over `npm`** for package installation — pnpm uses hardlinks and a content-addressable store, significantly saving disk space and improving speed.
- To install Node.js packages locally: `pnpm add <package>`
- To install CLI tools globally: `pnpm install -g <package>`
- Only use `npm` if the user explicitly requests it. Both `npm install -g` and `pnpm install -g` work correctly in this environment.
- `npx` is available for running one-off commands (e.g., `npx cowsay hello`). Note: npx caches downloaded packages in `/workspace/.npm/_npx/` — they are NOT deleted after execution and persist in the workspace.
- Example: `pnpm install -g @larksuite/cli`

### File Writing Rules
When the user asks to write or save content to a file without specifying an explicit path:
- Default output directory: `/workspace`

# Planning and User Interaction

## When to Plan First
For any non-trivial task (more than 2-3 steps), you MUST:
1. First, analyze the user's request and break it down into steps using TaskCreate
2. Present your plan to the user using AskUser and ask for confirmation BEFORE starting implementation
3. Only proceed after the user approves the plan

## When to Use AskUser
Use the AskUser tool proactively in these situations:
- **Ambiguous requirements**: When the user's request is unclear or has multiple valid interpretations, ask for clarification BEFORE guessing
- **Plan confirmation**: After creating a task plan for complex work, ask the user to review and approve it
- **Design decisions**: When there are multiple approaches with meaningful trade-offs (e.g., architecture choices, library selection), present options and let the user decide
- **Destructive operations**: Before performing any operation that could overwrite existing work, delete files, or make hard-to-reverse changes, ask for explicit confirmation
- **Missing information**: When you need specific details (file paths, configurations, preferences) that the user hasn't provided
- **Progress checkpoints**: For long-running multi-step tasks, check in with the user at key milestones

## When NOT to Use AskUser
- Simple, unambiguous requests with a single clear solution (e.g., "read file X", "list files in directory Y")
- When the user has already provided all necessary information and the task is straightforward
- Follow-up actions that were already approved as part of a plan

## Critical Rule
Do NOT assume the user's intent when their request is ambiguous. Do NOT silently choose an approach when multiple valid options exist. When in doubt, ASK.

# Safety and Permissions

## Dangerous Operations — Always Confirm First
Before executing any of the following, you MUST use AskUser to get explicit user confirmation:
- Deleting files or directories (rm, rmdir, unlink)
- Git operations that modify history (push, push --force, reset --hard, rebase, branch -D)
- Database destructive operations (DROP, DELETE FROM, TRUNCATE)
- Installing or removing system packages
- Overwriting existing files with significantly different content
- Running commands that could affect processes outside the workspace (kill, pkill)

## Safe Operations — No Confirmation Needed
- Reading files, searching, listing directories
- Creating new files that don't overwrite existing ones
- Running analysis or diagnostic commands
- Git status, log, diff (read-only git operations)

# Using your tools
- Do NOT use the Bash tool to read or write files when dedicated Read/Write tools are available. Using dedicated tools allows the user to better understand and review your work.
- Break down and manage your work with the TaskCreate tool. Use TaskCreate to plan your work and help the user track your progress. Mark each task as completed (via TaskUpdate) as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.
- You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially.

# Available Skills
{skills_text}

IMPORTANT: Before declining a user request because it's outside your domain, check if there's a relevant skill available.

## Installing Skills
Skills are loaded from `/workspace/skills/`. Each skill is a Markdown file (usually `SKILL.md`) with YAML frontmatter containing at least a `name` field. To install new skills:
1. Create the directory: `mkdir -p /workspace/skills/<skill-name>/`
2. Place the skill's `SKILL.md` and any reference files there
3. Skills from GitHub repos (e.g., larksuite/cli) can be installed by cloning and copying: `git clone <repo> /tmp/repo && cp -r /tmp/repo/skills/* /workspace/skills/ && rm -rf /tmp/repo`
4. Newly installed skills are automatically available on next Skill tool call — no restart needed"""


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

    permission_manager = PermissionManager(mode=PermissionMode.SERVER_SMART)

    cwd = workspace_root if workspace_root else Path.cwd()

    context = ToolUseContext(
        options=ToolOptions(tools=tools, model=model),
        session_id=session_id,
        cwd=cwd,
        abort_signal=AbortSignal(),
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
            compactor_state=session.context_manager.get_compactor_state() if session.context_manager else None,
        )

    def _write_feishu_config(self, session_id: str, feishu: "FeishuConfig") -> None:
        """将飞书凭证写入 session 目录的 feishu.json"""
        import json

        if not self._sandbox_manager:
            return
        feishu_file = self._sandbox_manager.config.feishu_config_file(session_id)
        feishu_file.write_text(
            json.dumps({"app_id": feishu.app_id, "app_secret": feishu.app_secret, "brand": feishu.brand}, indent=2),
            encoding="utf-8",
        )
        logger.debug("写入 session {} feishu.json", session_id)

    def create_session(
        self,
        model: str | None = None,
        max_turns: int | None = None,
        caller_system_prompt: str | None = None,
        feishu: "FeishuConfig | None" = None,
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
            if feishu:
                self._write_feishu_config(session_id, feishu)

        context, client = _create_session_context(
            resolved_model,
            internal_sid,
            workspace_root=workspace_root,
            sandbox_session_id=session_id if self._sandbox_manager else None,
        )

        from ripple.utils.paths import SERVER_CONVERSATIONS_DIR

        conversation_log = ConversationLogger(session_id=session_id, conversations_dir=SERVER_CONVERSATIONS_DIR)

        session = Session(
            session_id=session_id,
            context=context,
            client=client,
            model=resolved_model,
            caller_system_prompt=caller_system_prompt,
            max_turns=resolved_max_turns,
            conversation_log=conversation_log,
            context_manager=ContextManager(),
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

            # 记录会话结束
            if session.conversation_log:
                session.conversation_log.log_session_end()

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
                if session.context and session.context.abort_signal:
                    session.context.abort_signal.abort()
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

        from ripple.utils.paths import SERVER_CONVERSATIONS_DIR

        conversation_log = ConversationLogger(session_id=session_id, conversations_dir=SERVER_CONVERSATIONS_DIR)

        session = Session(
            session_id=session_id,
            messages=state.get("messages", []),
            context=context,
            client=client,
            model=resolved_model,
            caller_system_prompt=state.get("caller_system_prompt"),
            max_turns=state.get("max_turns", 10),
            created_at=created_at,
            total_input_tokens=state.get("total_input_tokens", 0),
            total_output_tokens=state.get("total_output_tokens", 0),
            status=state.get("status", SessionStatus.IDLE),
            pending_question=state.get("pending_question"),
            pending_options=state.get("pending_options"),
            pending_permission_request=state.get("pending_permission_request"),
            conversation_log=conversation_log,
            context_manager=ContextManager.from_persisted_state(state.get("compactor_state", {})),
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
                "status": s.status,
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
        caller_system_prompt: str | None = None,
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

        session = self.create_session(
            model=model,
            max_turns=max_turns,
            caller_system_prompt=caller_system_prompt,
        )
        return session, True
