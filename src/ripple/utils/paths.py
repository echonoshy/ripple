"""路径管理

集中定义 .ripple 下的目录结构，CLI 和 Server 使用隔离的子目录。

目录布局：
    .ripple/
    ├── cli/
    │   ├── workspace/          ← CLI 模型输出文件
    │   ├── conversations/      ← CLI 会话日志
    │   └── tasks/              ← CLI 后台任务输出
    ├── server/
    │   ├── sandboxes/          ← nsjail 沙箱（sessions/ + uv-cache/）
    │   ├── conversations/      ← Server 会话日志
    │   └── tasks/              ← Server 后台任务输出
    ├── logs/
    │   └── ripple.log          ← 共用日志
    └── tasks.json              ← CLI 规划任务列表（context.cwd 决定）
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

# 共用
LOG_DIR = RIPPLE_HOME / "logs"
LOG_FILE = LOG_DIR / "ripple.log"

# CLI 模式
CLI_DIR = RIPPLE_HOME / "cli"
CLI_WORKSPACE_DIR = CLI_DIR / "workspace"
CLI_CONVERSATIONS_DIR = CLI_DIR / "conversations"
CLI_TASKS_DIR = CLI_DIR / "tasks"

# Server 模式
SERVER_DIR = RIPPLE_HOME / "server"
SERVER_SANDBOXES_DIR = SERVER_DIR / "sandboxes"
SERVER_CONVERSATIONS_DIR = SERVER_DIR / "conversations"
SERVER_TASKS_DIR = SERVER_DIR / "tasks"
