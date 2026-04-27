"""User 沙箱工作空间管理

每个 user 拥有一个独立的 sandbox 目录：
    sandboxes_root/<user_id>/
        ├── workspace/            ← 用户文件（user 内所有 session 共享）
        ├── credentials/          ← 飞书/Notion 等凭证
        ├── nsjail.cfg            ← user 级 nsjail 配置
        └── sessions/<sid>/       ← 每个 session 的运行时状态
"""

import shutil
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.workspace")


def create_sandbox(config: SandboxConfig, user_id: str) -> Path:
    """为 user 初始化 sandbox 目录结构，返回 workspace 路径（幂等）。"""
    sandbox = config.sandbox_dir(user_id)
    workspace = config.workspace_dir(user_id)
    (sandbox / "credentials").mkdir(parents=True, exist_ok=True)
    (sandbox / "sessions").mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    logger.info("创建 user sandbox: {} → {}", user_id, sandbox)
    return workspace


def destroy_sandbox(config: SandboxConfig, user_id: str) -> bool:
    """销毁整个 user 的 sandbox（含所有 session）"""
    sandbox = config.sandbox_dir(user_id)
    if sandbox.exists():
        shutil.rmtree(sandbox)
        logger.info("销毁 user sandbox: {}", user_id)
        return True
    return False


def sandbox_exists(config: SandboxConfig, user_id: str) -> bool:
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


def get_workspace_size_bytes(config: SandboxConfig, user_id: str) -> int:
    """计算 user workspace 占用大小"""
    workspace = config.workspace_dir(user_id)
    if not workspace.exists():
        return 0
    total = 0
    for f in workspace.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    return total


def check_workspace_quota(config: SandboxConfig, user_id: str) -> tuple[bool, int]:
    """检查 user workspace 是否超出配额

    Returns:
        (是否超限, 当前大小字节数)
    """
    size = get_workspace_size_bytes(config, user_id)
    max_bytes = config.max_workspace_mb * 1024 * 1024
    return size > max_bytes, size


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
