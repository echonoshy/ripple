"""日志模块

基于 loguru 提供统一的日志管理。
日志和会话记录存储在项目根目录的 .ripple/ 下。
"""

from pathlib import Path

from loguru import logger

# 模块加载时立即移除默认的 stderr handler，防止日志泄漏到终端
logger.remove()


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

_initialized = False


def setup_logging(level: str = "DEBUG", max_bytes: int = 5 * 1024 * 1024, backup_count: int = 3):
    """初始化日志系统，添加文件 sink

    在 setup_logging() 调用之前，所有日志会被静默丢弃（无 sink）。
    应在应用入口处尽早调用。

    Args:
        level: 日志级别 (DEBUG, INFO, WARNING, ERROR)
        max_bytes: 单个日志文件最大大小（默认 5MB）
        backup_count: 保留的日志文件备份数量
    """
    global _initialized
    if _initialized:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    rotation_mb = f"{max_bytes / (1024 * 1024):.1f} MB"
    logger.add(
        LOG_FILE,
        level=level.upper(),
        format="{time:YYYY-MM-DD HH:mm:ss} [{level}] {extra[module]}: {message}",
        rotation=rotation_mb,
        retention=backup_count,
        encoding="utf-8",
        enqueue=True,
    )

    _initialized = True


def get_logger(name: str) -> "logger":
    """获取带模块名的 logger

    不会自动触发 setup_logging()。在 setup_logging() 调用前，
    返回的 logger 写入的消息会被静默丢弃。

    Args:
        name: 模块名称

    Returns:
        绑定了 module 上下文的 loguru logger
    """
    return logger.bind(module=name)
