"""会话工作空间管理

每个 session 拥有独立的工作空间目录，所有文件操作限制在其中。
"""

import shutil
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.workspace")


def create_workspace(config: SandboxConfig, session_id: str) -> Path:
    """创建 session 工作空间目录

    目录结构：
        .ripple/sessions/<session_id>/
        ├── workspace/        ← 用户文件
        ├── meta.json         ← 会话元数据（由 storage 模块管理）
        ├── messages.jsonl    ← 对话历史（由 storage 模块管理）
        ├── tasks.json        ← TaskTool 的 todo 列表
        ├── task-outputs/     ← AgentTool 后台任务输出
        └── nsjail.cfg
    """
    workspace = config.workspace_dir(session_id)
    workspace.mkdir(parents=True, exist_ok=True)
    logger.info("创建工作空间: {} → {}", session_id, workspace)
    return workspace


def destroy_workspace(config: SandboxConfig, session_id: str) -> bool:
    """销毁 session 工作空间"""
    session_dir = config.session_dir(session_id)
    if session_dir.exists():
        shutil.rmtree(session_dir)
        logger.info("销毁工作空间: {}", session_id)
        return True
    return False


def workspace_exists(config: SandboxConfig, session_id: str) -> bool:
    return config.workspace_dir(session_id).exists()


def get_workspace_size_bytes(config: SandboxConfig, session_id: str) -> int:
    """计算工作空间占用大小"""
    workspace = config.workspace_dir(session_id)
    if not workspace.exists():
        return 0
    total = 0
    for f in workspace.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    return total


def check_workspace_quota(config: SandboxConfig, session_id: str) -> tuple[bool, int]:
    """检查 workspace 是否超出配额

    Returns:
        (是否超限, 当前大小字节数)
    """
    size = get_workspace_size_bytes(config, session_id)
    max_bytes = config.max_workspace_mb * 1024 * 1024
    return size > max_bytes, size


# --- user 维度 API (Phase 2-5 过渡期) ---


def create_user_workspace(config: SandboxConfig, user_id: str) -> Path:
    """为 user 初始化 sandbox 目录结构，返回 workspace 路径（幂等）。"""
    sandbox = config.sandbox_dir(user_id)
    workspace = config.workspace_dir_by_uid(user_id)
    (sandbox / "credentials").mkdir(parents=True, exist_ok=True)
    (sandbox / "sessions").mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    logger.info("创建 user sandbox: {} → {}", user_id, sandbox)
    return workspace


def destroy_user_sandbox(config: SandboxConfig, user_id: str) -> bool:
    """销毁整个 user 的 sandbox（含所有 session）"""
    sandbox = config.sandbox_dir(user_id)
    if sandbox.exists():
        shutil.rmtree(sandbox)
        logger.info("销毁 user sandbox: {}", user_id)
        return True
    return False


def user_sandbox_exists(config: SandboxConfig, user_id: str) -> bool:
    return config.sandbox_dir(user_id).exists()


def list_user_sessions(config: SandboxConfig, user_id: str) -> list[str]:
    """列出某 user 下所有有 meta.json 的 session"""
    sessions_dir = config.sandbox_dir(user_id) / "sessions"
    if not sessions_dir.exists():
        return []
    return [d.name for d in sessions_dir.iterdir() if d.is_dir() and (d / "meta.json").exists()]


def list_all_user_ids(config: SandboxConfig) -> list[str]:
    """枚举 sandboxes_root 下的所有 user_id"""
    if not config.sandboxes_root.exists():
        return []
    return [d.name for d in config.sandboxes_root.iterdir() if d.is_dir()]


SANDBOX_VIRTUAL_ROOT = Path("/workspace")


def validate_path(file_path: str | Path, workspace_root: Path) -> Path:
    """校验路径是否在 workspace 范围内

    防止路径遍历攻击（如 ../../etc/shadow、符号链接逃逸等）。
    支持 /workspace 虚拟路径自动映射到实际 workspace_root。

    Returns:
        解析后的安全路径

    Raises:
        PermissionError: 路径越界
    """
    target = Path(file_path)

    if _is_under_virtual_root(target):
        try:
            relative = target.relative_to(SANDBOX_VIRTUAL_ROOT)
        except ValueError:
            relative = Path(".")
        target = workspace_root / relative
    elif not target.is_absolute():
        target = workspace_root / target

    resolved = target.resolve()
    workspace_resolved = workspace_root.resolve()

    if not str(resolved).startswith(str(workspace_resolved) + "/") and resolved != workspace_resolved:
        raise PermissionError(f"Access denied: path '{file_path}' is outside the sandbox workspace")

    return resolved


def _is_under_virtual_root(path: Path) -> bool:
    """判断路径是否在 /workspace 虚拟根目录下"""
    try:
        path.relative_to(SANDBOX_VIRTUAL_ROOT)
        return True
    except ValueError:
        return False


def list_suspended_sessions(config: SandboxConfig) -> list[str]:
    """列出所有磁盘上有持久化状态的 session"""
    sessions_root = config.sessions_root
    if not sessions_root.exists():
        return []
    return [d.name for d in sessions_root.iterdir() if d.is_dir() and (d / "meta.json").exists()]
