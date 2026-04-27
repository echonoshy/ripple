"""日志模块

基于 loguru 提供统一日志。默认只写一个 ``.ripple/logs/ripple.log``，让一次请求的 HTTP、
agent、LLM、tool、sandbox 事件按时间顺序出现在同一条时间线里。

日志格式保持 human-readable，同时用稳定的 ``key=value`` 字段方便 grep::

    YYYY-MM-DD HH:mm:ss.SSS LEVEL req=<request_id> user=<user_id> session=<session_id> module=<module> | event=...
"""

from contextlib import contextmanager
from contextvars import ContextVar
from uuid import uuid4

from loguru import logger as _loguru_logger

from ripple.utils.paths import LOG_DIR, LOG_FILE, RIPPLE_HOME  # noqa: F401

_loguru_logger.remove()

_ctx_user_id: ContextVar[str | None] = ContextVar("ripple_log_user_id", default=None)
_ctx_session_id: ContextVar[str | None] = ContextVar("ripple_log_session_id", default=None)
_ctx_request_id: ContextVar[str | None] = ContextVar("ripple_log_request_id", default=None)

_DEFAULT_EXTRA = {
    "module": "-",
    "user_id": "-",
    "session_id": "-",
    "request_id": "-",
    "channel": "app",
}
_loguru_logger.configure(extra=_DEFAULT_EXTRA)

_HUMAN_FORMAT = (
    "{time:YYYY-MM-DD HH:mm:ss.SSS} "
    "{level:<5} "
    "req={extra[request_id]} "
    "user={extra[user_id]} "
    "session={extra[session_id]} "
    "module={extra[module]} | "
    "{message}"
)

_initialized = False


def _inject_context(record: dict) -> None:
    """把当前请求上下文注入 loguru record。"""
    extra = record["extra"]
    for key, var in (
        ("user_id", _ctx_user_id),
        ("session_id", _ctx_session_id),
        ("request_id", _ctx_request_id),
    ):
        ctx_value = var.get()
        if ctx_value is not None:
            extra[key] = ctx_value
        else:
            extra.setdefault(key, _DEFAULT_EXTRA[key])
    extra.setdefault("module", _DEFAULT_EXTRA["module"])
    extra.setdefault("channel", _DEFAULT_EXTRA["channel"])


logger = _loguru_logger.patch(_inject_context)


def setup_logging(
    level: str = "DEBUG",
    rotation: str | int = "50 MB",
    retention: str | int = "14 days",
) -> None:
    """初始化单文件日志系统。"""
    global _initialized
    if _initialized:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)

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
    )

    _initialized = True


def get_logger(name: str):
    """获取带模块名的 logger。"""
    return logger.bind(module=name)


def new_request_id() -> str:
    """生成一个短随机 request_id（12 位十六进制）。"""
    return uuid4().hex[:12]


@contextmanager
def session_context(session_id: str):
    """临时绑定 session_id。"""
    token = _ctx_session_id.set(session_id)
    try:
        yield
    finally:
        _ctx_session_id.reset(token)


def set_current_session_id(session_id: str) -> None:
    """把当前请求日志上下文里的 session_id 更新为真实 session_id。"""
    _ctx_session_id.set(session_id)


@contextmanager
def request_context(
    user_id: str = "-",
    session_id: str = "-",
    request_id: str | None = None,
):
    """绑定 user_id / session_id / request_id 到当前请求作用域。"""
    rid = request_id or new_request_id()
    user_token = _ctx_user_id.set(user_id)
    session_token = _ctx_session_id.set(session_id)
    request_token = _ctx_request_id.set(rid)
    try:
        yield rid
    finally:
        _ctx_user_id.reset(user_token)
        _ctx_session_id.reset(session_token)
        _ctx_request_id.reset(request_token)
