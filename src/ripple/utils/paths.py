"""路径管理

集中定义 .ripple 下的目录结构。

目录布局：
    .ripple/
    ├── logs/
    │   └── ripple.log            ← 进程日志
    ├── sandboxes-cache/          ← 跨 session/user 共享的包缓存（uv / corepack / pnpm）
    │   ├── uv-cache/
    │   ├── corepack-cache/
    │   └── pnpm-store/           (可选，宿主机没有 pnpm store 时使用)
    ├── sessions/                 ← [DEPRECATED: 旧 session 级布局，将在 Phase 6 清理]
    │   └── <session_id>/...
    └── sandboxes/                ← user 级沙箱（新布局）
        └── <user_id>/
            ├── credentials/
            ├── workspace/
            ├── nsjail.cfg
            └── sessions/
                └── <session_id>/
                    ├── meta.json
                    ├── messages.jsonl
                    ├── tasks.json
                    └── task-outputs/
"""

from pathlib import Path


def _find_project_root() -> Path:
    """查找项目根目录（包含 pyproject.toml 的目录）"""
    current = Path.cwd()
    while current != current.parent:
        if (current / "pyproject.toml").exists():
            return current
        current = current.parent
    return Path.cwd()


RIPPLE_HOME = _find_project_root() / ".ripple"

LOG_DIR = RIPPLE_HOME / "logs"
LOG_FILE = LOG_DIR / "ripple.log"

SESSIONS_DIR = RIPPLE_HOME / "sessions"
SANDBOXES_CACHE_DIR = RIPPLE_HOME / "sandboxes-cache"
SANDBOXES_DIR = RIPPLE_HOME / "sandboxes"
