"""日志模块

基于 loguru 提供统一的日志管理。日志存储在项目根目录的 .ripple/logs/ 下。

## 日志字段

所有日志行格式（human-readable）::

    YYYY-MM-DD HH:mm:ss.SSS  LEVEL    <user_id>/<session_id>  [<request_id>]  <module>  <message>

其中：

- ``user_id``     — HTTP 请求里的 X-Ripple-User-Id（默认 "default"，非请求上下文为 "-"）
- ``session_id``  — 当前 session（无则 "-"）
- ``request_id``  — 单次 HTTP 请求的短 uuid；非请求上下文为 "-"；响应里会回传 X-Request-Id

## 日志分流

- ``ripple.log`` — 所有 channel != "access" 的日志（含 app + llm_call）
- ``access.log`` — 仅 channel == "access"（HTTP 访问日志，由中间件写入）
- ``llm.log``    — 仅 channel == "llm"（LLM 调用结构化摘要）— 可选开关

在任意业务代码里想分流到 llm.log 只需 ``logger.bind(channel="llm").info(...)``。

## 上下文注入

优先使用 :func:`request_context`（FastAPI 中间件调用）同时绑 user_id / session_id / request_id。
后台任务（cleanup loop 等）可在任务入口显式调用 ``logger.contextualize(...)`` 绑定上下文。
"""

from contextlib import contextmanager
from uuid import uuid4

from loguru import logger

from ripple.utils.paths import LOG_DIR, LOG_FILE, RIPPLE_HOME  # noqa: F401

# 模块加载时立即移除默认的 stderr handler，防止日志泄漏到终端
logger.remove()

# 默认 extras — 确保即使没有 bind/contextualize，格式化也不会 KeyError
_DEFAULT_EXTRA = {
    "module": "-",
    "user_id": "-",
    "session_id": "-",
    "request_id": "-",
    "channel": "app",
}
logger.configure(extra=_DEFAULT_EXTRA)

_HUMAN_FORMAT = (
    "{time:YYYY-MM-DD HH:mm:ss.SSS} "
    "{level:<5} "
    "{extra[user_id]}/{extra[session_id]} "
    "[{extra[request_id]}] "
    "{extra[module]} | "
    "{message}"
)

_initialized = False


def setup_logging(
    level: str = "DEBUG",
    rotation: str | int = "50 MB",
    retention: str | int = "14 days",
    access_log: bool = True,
    llm_log: bool = True,
):
    """初始化日志系统

    Args:
        level: 主日志级别
        rotation: 单文件轮转阈值（如 "50 MB"、"100 MB" 或字节数）
        retention: 轮转后保留策略（如 "14 days"、"30 days" 或保留文件数）
        access_log: 是否启用独立的 access.log（HTTP 访问日志）
        llm_log: 是否启用独立的 llm.log（LLM 调用摘要）
    """
    global _initialized
    if _initialized:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # 主日志：排除 access channel，llm channel 同时进 ripple.log 方便时间线对齐
    logger.add(
        LOG_FILE,
        level=level.upper(),
        format=_HUMAN_FORMAT,
        rotation=rotation,
        retention=retention,
        encoding="utf-8",
        enqueue=True,
        backtrace=False,
        diagnose=False,
        filter=lambda record: record["extra"].get("channel", "app") != "access",
    )

    if access_log:
        logger.add(
            LOG_DIR / "access.log",
            level="INFO",
            format=_HUMAN_FORMAT,
            rotation=rotation,
            retention=retention,
            encoding="utf-8",
            enqueue=True,
            backtrace=False,
            diagnose=False,
            filter=lambda record: record["extra"].get("channel") == "access",
        )

    if llm_log:
        logger.add(
            LOG_DIR / "llm.log",
            level="INFO",
            format=_HUMAN_FORMAT,
            rotation=rotation,
            retention=retention,
            encoding="utf-8",
            enqueue=True,
            backtrace=False,
            diagnose=False,
            filter=lambda record: record["extra"].get("channel") == "llm",
        )

    _initialized = True


def get_logger(name: str) -> "logger":
    """获取带模块名的 logger

    Args:
        name: 模块名称，会填充到日志行的 module 字段

    Returns:
        loguru logger（绑定了 module 上下文）
    """
    return logger.bind(module=name)


def new_request_id() -> str:
    """生成一个短随机 request_id（12 位十六进制）"""
    return uuid4().hex[:12]


@contextmanager
def session_context(session_id: str):
    """仅绑定 session_id 的上下文管理器（向后兼容）

    新代码优先用 :func:`request_context` 一次绑 user_id / session_id / request_id。
    """
    with logger.contextualize(session_id=session_id):
        yield


@contextmanager
def request_context(
    user_id: str = "-",
    session_id: str = "-",
    request_id: str | None = None,
):
    """绑定 user_id / session_id / request_id 到后续所有日志调用

    基于 loguru 的 contextualize，使用 Python contextvars，
    在当前协程及其派生协程内自动继承。

    Args:
        user_id: 用户 ID（X-Ripple-User-Id），未知用 "-"
        session_id: 会话 ID，未知用 "-"
        request_id: 请求 ID；为 None 时自动生成

    Yields:
        实际使用的 request_id（调用方可用来写到响应头）
    """
    rid = request_id or new_request_id()
    with logger.contextualize(user_id=user_id, session_id=session_id, request_id=rid):
        yield rid
