"""沙箱管理器

协调 nsjail 工作空间创建/销毁、配置生成、会话持久化等。
"""

import asyncio
from datetime import datetime, timezone
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.executor import check_nsjail_available
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.sandbox.storage import (
    delete_session_state,
    get_suspended_session_info,
    load_session_state,
    save_session_state,
)
from ripple.sandbox.workspace import (
    create_workspace,
    destroy_workspace,
    get_workspace_size_bytes,
    list_suspended_sessions,
    workspace_exists,
)
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.manager")


class SandboxManager:
    """沙箱生命周期管理器"""

    def __init__(self, config: SandboxConfig | None = None):
        self.config = config or SandboxConfig()
        check_nsjail_available(self.config.nsjail_path)
        self._user_locks: dict[str, asyncio.Lock] = {}
        logger.info(
            "SandboxManager 初始化: sessions={}, caches={}",
            self.config.sessions_root,
            self.config.caches_root,
        )

    def setup_session(self, session_id: str) -> Path:
        """为 session 初始化沙箱环境，返回 workspace 路径"""
        workspace = create_workspace(self.config, session_id)
        write_nsjail_config(self.config, session_id)
        logger.info("Session {} 沙箱就绪", session_id)
        return workspace

    def teardown_session(self, session_id: str):
        """销毁 session 的沙箱环境"""
        delete_session_state(self.config, session_id)
        destroy_workspace(self.config, session_id)

    def suspend_session(
        self,
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
    ) -> bool:
        """挂起 session：保存状态到磁盘，保留工作空间文件"""
        if not workspace_exists(self.config, session_id):
            logger.warning("无法挂起: session {} 没有工作空间", session_id)
            return False

        save_session_state(
            self.config,
            session_id,
            messages=messages,
            model=model,
            caller_system_prompt=caller_system_prompt,
            max_turns=max_turns,
            total_input_tokens=total_input_tokens,
            total_output_tokens=total_output_tokens,
            created_at=created_at,
            last_active=last_active,
            status=status,
            pending_question=pending_question,
            pending_options=pending_options,
            pending_permission_request=pending_permission_request,
            compactor_state=compactor_state,
        )

        logger.info("Session {} 已挂起", session_id)
        return True

    def resume_session(self, session_id: str) -> dict | None:
        """恢复 session：从磁盘加载状态"""
        state = load_session_state(self.config, session_id)
        if state is None:
            logger.warning("无法恢复: session {} 没有持久化状态", session_id)
            return None

        if not workspace_exists(self.config, session_id):
            workspace = create_workspace(self.config, session_id)
            logger.info("恢复时重建工作空间: {}", workspace)

        write_nsjail_config(self.config, session_id)

        logger.info("Session {} 已恢复", session_id)
        return state

    def list_suspended(self) -> list[dict]:
        """列出所有已挂起的 session 摘要"""
        result = []
        for sid in list_suspended_sessions(self.config):
            info = get_suspended_session_info(self.config, sid)
            if info:
                result.append(info)
        return result

    def get_session_workspace(self, session_id: str) -> Path | None:
        workspace = self.config.workspace_dir(session_id)
        return workspace if workspace.exists() else None

    def get_workspace_size(self, session_id: str) -> int:
        return get_workspace_size_bytes(self.config, session_id)

    def cleanup_expired_suspended(self):
        """清理过期的已挂起 session"""
        now = datetime.now(timezone.utc)
        for sid in list_suspended_sessions(self.config):
            info = get_suspended_session_info(self.config, sid)
            if not info:
                continue
            suspended_at_str = info.get("suspended_at", "")
            if not suspended_at_str:
                continue
            try:
                suspended_at = datetime.fromisoformat(suspended_at_str)
                if (now - suspended_at).total_seconds() > self.config.retention_seconds:
                    logger.info("清理过期挂起 session: {} (挂起于 {})", sid, suspended_at_str)
                    self.teardown_session(sid)
            except (ValueError, TypeError):
                continue

    # --- user 维度 API (Phase 2-5 过渡期) ---

    def user_lock(self, user_id: str) -> asyncio.Lock:
        """获取 user 级工具调用锁；所有会修改 user workspace 的命令前应 `async with`"""
        return self._user_locks.setdefault(user_id, asyncio.Lock())

    def ensure_sandbox(self, user_id: str) -> Path:
        """幂等地为 user 创建沙箱环境（workspace + nsjail.cfg）"""
        from ripple.sandbox.nsjail_config import write_nsjail_config_uid
        from ripple.sandbox.workspace import create_user_workspace

        workspace = create_user_workspace(self.config, user_id)
        write_nsjail_config_uid(self.config, user_id)
        logger.info("user {} 沙箱就绪", user_id)
        return workspace

    def teardown_sandbox(self, user_id: str, *, allow_default: bool = False) -> bool:
        """销毁整个 user sandbox（含所有 session）"""
        if user_id == "default" and not allow_default:
            raise PermissionError("default user sandbox cannot be torn down")
        from ripple.sandbox.workspace import destroy_user_sandbox

        self._user_locks.pop(user_id, None)
        return destroy_user_sandbox(self.config, user_id)

    def setup_session_uid(self, user_id: str, session_id: str) -> Path:
        """在已存在的 user sandbox 下创建 session 目录（若 sandbox 缺失则一并创建）"""
        from ripple.sandbox.workspace import create_user_workspace

        create_user_workspace(self.config, user_id)
        session_dir = self.config.session_dir_by_uid(user_id, session_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        self.config.task_outputs_dir_by_uid(user_id, session_id).mkdir(exist_ok=True)
        logger.info("user {} session {} 就绪", user_id, session_id)
        return session_dir

    def teardown_session_uid(self, user_id: str, session_id: str) -> None:
        """仅删 session 目录，保留 sandbox"""
        import shutil

        from ripple.sandbox.storage import delete_session_state_uid

        delete_session_state_uid(self.config, user_id, session_id)
        session_dir = self.config.session_dir_by_uid(user_id, session_id)
        if session_dir.exists():
            shutil.rmtree(session_dir)

    def suspend_session_uid(
        self,
        user_id: str,
        session_id: str,
        **kwargs,
    ) -> bool:
        """挂起：只写 meta.json + messages.jsonl，保留 workspace"""
        from ripple.sandbox.storage import save_session_state_uid
        from ripple.sandbox.workspace import user_sandbox_exists

        if not user_sandbox_exists(self.config, user_id):
            logger.warning("无法挂起: user {} 无 sandbox", user_id)
            return False
        save_session_state_uid(self.config, user_id, session_id, **kwargs)
        return True

    def resume_session_uid(self, user_id: str, session_id: str) -> dict | None:
        """从磁盘恢复 session 状态；sandbox 缺了就重建"""
        from ripple.sandbox.nsjail_config import write_nsjail_config_uid
        from ripple.sandbox.storage import load_session_state_uid
        from ripple.sandbox.workspace import user_sandbox_exists

        state = load_session_state_uid(self.config, user_id, session_id)
        if state is None:
            return None
        if not user_sandbox_exists(self.config, user_id):
            self.ensure_sandbox(user_id)
        write_nsjail_config_uid(self.config, user_id)
        return state

    def list_user_sandboxes(self) -> list[str]:
        """列出所有已存在的 user_id"""
        from ripple.sandbox.workspace import list_all_user_ids

        return list_all_user_ids(self.config)

    def list_user_sessions(self, user_id: str) -> list[str]:
        from ripple.sandbox.workspace import list_user_sessions as _list

        return _list(self.config, user_id)

    def sandbox_summary(self, user_id: str) -> dict | None:
        """为 GET /v1/sandboxes 返回的摘要"""
        from ripple.sandbox.workspace import user_sandbox_exists

        if not user_sandbox_exists(self.config, user_id):
            return None
        ws_size = 0
        ws = self.config.workspace_dir_by_uid(user_id)
        if ws.exists():
            for f in ws.rglob("*"):
                if f.is_file():
                    ws_size += f.stat().st_size
        return {
            "user_id": user_id,
            "workspace_size_bytes": ws_size,
            "session_count": len(self.list_user_sessions(user_id)),
            "has_python_venv": self.config.has_python_venv_by_uid(user_id),
            "has_pnpm_setup": self.config.has_pnpm_setup_by_uid(user_id),
            "has_lark_cli_config": self.config.has_lark_cli_config_by_uid(user_id),
            "has_notion_token": self.config.has_notion_token_by_uid(user_id),
        }
