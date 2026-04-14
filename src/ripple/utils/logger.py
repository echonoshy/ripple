"""日志模块

基于 loguru 提供统一的日志管理。
日志存储在项目根目录的 .ripple/logs/ 下。
"""

from contextlib import contextmanager

from loguru import logger

from ripple.utils.paths import LOG_DIR, LOG_FILE, RIPPLE_HOME  # noqa: F401

# 模块加载时立即移除默认的 stderr handler，防止日志泄漏到终端
logger.remove()

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
        format="{time:YYYY-MM-DD HH:mm:ss} [{level}] {extra[module]}({extra[session_id]}): {message}",
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
        绑定了 module 和默认 session_id 上下文的 loguru logger
    """
    return logger.bind(module=name, session_id="-")


@contextmanager
def session_context(session_id: str):
    """设置当前协程/线程的 session_id 日志上下文

    在此上下文管理器内的所有日志调用都会自动包含 session_id。
    基于 loguru 的 contextualize，使用 Python contextvars，
    天然支持 asyncio 协程隔离。

    用法::

        with session_context("srv-abc123"):
            logger.info("这条日志会带上 session_id")
    """
    with logger.contextualize(session_id=session_id):
        yield
