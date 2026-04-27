"""Request 上下文中间件

纯 ASGI 实现（刻意不用 starlette 的 BaseHTTPMiddleware，后者会缓冲流式响应体，
在 SSE 场景下会破坏心跳时序）。

职责：

1. 从 ``X-Request-Id``（优先透传）或自动生成一个短 request_id
2. 从 ``X-Ripple-User-Id`` 解析 user_id（回落 "default"，非法字符回落 "-"）
3. 若路径里形如 ``/v1/sessions/<sid>/...``，抽出 session_id 做上下文预绑定
   （handler 在拿到 Session 对象后仍可用 ``logger.contextualize(session_id=...)``
   做更精细的绑定；嵌套上下文自动覆盖）
4. 用 :func:`ripple.utils.logger.request_context` 把三个字段绑到整个请求 scope 内所有日志调用
5. 请求结束时写一条 access 日志，并把 ``X-Request-Id`` 回写到响应头

不做鉴权 / user_id 合法性校验 —— 那是 ``deps.get_user_id`` / ``auth.verify_api_key``
的职责；中间件只负责"尽力抓到"上下文用于日志。
"""

import time
from collections.abc import Awaitable, Callable
from typing import Any

from ripple.sandbox.config import _USER_ID_RE
from ripple.utils.logger import get_logger, new_request_id, request_context

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

_app_logger = get_logger("http")

_MAX_REQUEST_ID_LEN = 64
_SESSION_ID_PATH_MARKER = "sessions"


def _extract_session_id_from_path(path: str) -> str:
    """从 URL path 里尽力抓 session_id

    命中形如 ``/v1/sessions/<sid>/...`` 或 ``/v1/sessions/<sid>``，
    其中 sid 满足 session_id 字符集（复用与后端一致的规则）。
    其他路径返回 "-"。
    """
    parts = [p for p in path.split("/") if p]
    for idx, seg in enumerate(parts):
        if seg != _SESSION_ID_PATH_MARKER:
            continue
        if idx + 1 >= len(parts):
            break
        candidate = parts[idx + 1]
        # 排除 RESTful 枚举端点
        if candidate in {"suspended"}:
            break
        if _USER_ID_RE.match(candidate):  # session_id 字符集与 user_id 相同
            return candidate
    return "-"


def _headers_as_dict(scope: Scope) -> dict[str, str]:
    """把 scope['headers'] 转成 lowercase dict（latin-1 解码，符合 HTTP 规范）"""
    out: dict[str, str] = {}
    for key, value in scope.get("headers", []):
        try:
            k = key.decode("latin-1").lower()
            v = value.decode("latin-1")
        except UnicodeDecodeError:
            continue
        out[k] = v
    return out


class RequestContextMiddleware:
    """把 user_id / session_id / request_id 绑定到请求作用域内所有日志"""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = _headers_as_dict(scope)

        incoming_rid = (headers.get("x-request-id") or "").strip()
        request_id = incoming_rid if (1 <= len(incoming_rid) <= _MAX_REQUEST_ID_LEN) else new_request_id()

        uid_raw = (headers.get("x-ripple-user-id") or "default").strip()
        user_id = uid_raw if _USER_ID_RE.match(uid_raw) else "-"

        path = scope.get("path", "") or ""
        method = scope.get("method", "?")
        session_id = _extract_session_id_from_path(path)

        start = time.monotonic()
        response_info: dict[str, Any] = {"status": 0, "bytes": 0}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_info["status"] = message.get("status", 0)
                # 注入 X-Request-Id 响应头
                existing = list(message.get("headers", []) or [])
                existing.append((b"x-request-id", request_id.encode("latin-1")))
                message["headers"] = existing
            elif message["type"] == "http.response.body":
                body = message.get("body", b"") or b""
                response_info["bytes"] += len(body)
            await send(message)

        with request_context(user_id=user_id, session_id=session_id, request_id=request_id):
            try:
                await self.app(scope, receive, send_wrapper)
            except Exception:
                elapsed_ms = (time.monotonic() - start) * 1000.0
                _app_logger.exception(
                    "event=http.request.error method={} path={} status=500 duration_ms={:.1f} bytes={}",
                    method,
                    path,
                    elapsed_ms,
                    response_info["bytes"],
                )
                raise

            elapsed_ms = (time.monotonic() - start) * 1000.0
            # 健康检查刷屏价值低，降级到 DEBUG；其他接口固定 INFO
            log_fn = _app_logger.debug if path == "/health" else _app_logger.info
            log_fn(
                "event=http.request.end method={} path={} status={} duration_ms={:.1f} bytes={}",
                method,
                path,
                response_info["status"],
                elapsed_ms,
                response_info["bytes"],
            )
