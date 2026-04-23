"""沙箱管理器

协调 nsjail 工作空间创建/销毁、配置生成、会话持久化等。
所有方法均以 user_id 为主键，session_id 作为 user 下的二级维度。
"""

import asyncio
import shutil
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.executor import check_nsjail_available
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.sandbox.storage import (
    delete_session_state,
    load_session_state,
    save_session_state,
)
from ripple.sandbox.workspace import (
    create_sandbox,
    destroy_sandbox,
    list_all_user_ids,
    list_user_sessions,
    sandbox_exists,
)
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.manager")


class SandboxManager:
    """沙箱生命周期管理器（user 维度）"""

    def __init__(self, config: SandboxConfig | None = None):
        self.config = config or SandboxConfig()
        check_nsjail_available(self.config.nsjail_path)
        self._user_locks: dict[str, asyncio.Lock] = {}
        logger.info(
            "SandboxManager 初始化: sandboxes={}, caches={}",
            self.config.sandboxes_root,
            self.config.caches_root,
        )

    def user_lock(self, user_id: str) -> asyncio.Lock:
        """获取 user 级工具调用锁；所有会修改 user workspace 的命令前应 `async with`"""
        return self._user_locks.setdefault(user_id, asyncio.Lock())

    def ensure_sandbox(self, user_id: str) -> Path:
        """幂等地为 user 创建沙箱环境（workspace + nsjail.cfg）"""
        workspace = create_sandbox(self.config, user_id)
        write_nsjail_config(self.config, user_id)
        logger.info("user {} 沙箱就绪", user_id)
        return workspace

    def teardown_sandbox(self, user_id: str, *, allow_default: bool = False) -> bool:
        """销毁整个 user sandbox（含所有 session）"""
        if user_id == "default" and not allow_default:
            raise PermissionError("default user sandbox cannot be torn down")
        self._user_locks.pop(user_id, None)
        return destroy_sandbox(self.config, user_id)

    def setup_session(self, user_id: str, session_id: str) -> Path:
        """在已存在的 user sandbox 下创建 session 目录（若 sandbox 缺失则一并创建）"""
        create_sandbox(self.config, user_id)
        session_dir = self.config.session_dir(user_id, session_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        self.config.task_outputs_dir(user_id, session_id).mkdir(exist_ok=True)
        logger.info("user {} session {} 就绪", user_id, session_id)
        return session_dir

    def teardown_session(self, user_id: str, session_id: str) -> None:
        """仅删 session 目录，保留 sandbox"""
        delete_session_state(self.config, user_id, session_id)
        session_dir = self.config.session_dir(user_id, session_id)
        if session_dir.exists():
            shutil.rmtree(session_dir)

    def suspend_session(
        self,
        user_id: str,
        session_id: str,
        **kwargs,
    ) -> bool:
        """挂起：只写 meta.json + messages.jsonl，保留 workspace"""
        if not sandbox_exists(self.config, user_id):
            logger.warning("无法挂起: user {} 无 sandbox", user_id)
            return False
        save_session_state(self.config, user_id, session_id, **kwargs)
        return True

    def resume_session(self, user_id: str, session_id: str) -> dict | None:
        """从磁盘恢复 session 状态；sandbox 缺了就重建"""
        state = load_session_state(self.config, user_id, session_id)
        if state is None:
            return None
        if not sandbox_exists(self.config, user_id):
            self.ensure_sandbox(user_id)
        write_nsjail_config(self.config, user_id)
        return state

    def list_user_sandboxes(self) -> list[str]:
        """列出所有已存在的 user_id"""
        return list_all_user_ids(self.config)

    def list_user_sessions(self, user_id: str) -> list[str]:
        return list_user_sessions(self.config, user_id)

    def get_workspace_size(self, user_id: str) -> int:
        from ripple.sandbox.workspace import get_workspace_size_bytes

        return get_workspace_size_bytes(self.config, user_id)

    def cleanup_expired_suspended(self):
        """清理过期的已挂起 session（跨所有 user）"""
        from datetime import datetime, timezone

        from ripple.sandbox.storage import get_suspended_session_info

        now = datetime.now(timezone.utc)
        for uid in self.list_user_sandboxes():
            for sid in self.list_user_sessions(uid):
                info = get_suspended_session_info(self.config, uid, sid)
                if not info:
                    continue
                suspended_at_str = info.get("suspended_at", "")
                if not suspended_at_str:
                    continue
                try:
                    suspended_at = datetime.fromisoformat(suspended_at_str)
                except (ValueError, TypeError):
                    continue
                if (now - suspended_at).total_seconds() > self.config.retention_seconds:
                    with logger.contextualize(user_id=uid, session_id=sid, request_id="cleanup"):
                        logger.info("清理过期挂起 session (挂起于 {})", suspended_at_str)
                        self.teardown_session(uid, sid)

    def sandbox_summary(self, user_id: str) -> dict | None:
        """为 GET /v1/sandboxes 返回的摘要"""
        if not sandbox_exists(self.config, user_id):
            return None
        ws_size = 0
        ws = self.config.workspace_dir(user_id)
        if ws.exists():
            for f in ws.rglob("*"):
                if f.is_file():
                    ws_size += f.stat().st_size
        return {
            "user_id": user_id,
            "workspace_size_bytes": ws_size,
            "session_count": len(self.list_user_sessions(user_id)),
            "has_python_venv": self.config.has_python_venv(user_id),
            "has_pnpm_setup": self.config.has_pnpm_setup(user_id),
            "has_lark_cli_config": self.config.has_lark_cli_config(user_id),
            "has_notion_token": self.config.has_notion_token(user_id),
            "has_gogcli_client_config": self.config.has_gogcli_client_config(user_id),
            "has_gogcli_login": self.config.has_gogcli_login(user_id),
        }
