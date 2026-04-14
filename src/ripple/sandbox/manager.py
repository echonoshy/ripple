"""沙箱管理器

协调 nsjail 工作空间创建/销毁、配置生成、会话持久化等。
"""

from datetime import datetime, timezone
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.executor import check_nsjail_available, write_nsjail_config
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
        logger.info("SandboxManager 初始化: root={}", self.config.sandboxes_root)

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
        system_prompt: str | None,
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
            system_prompt=system_prompt,
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
