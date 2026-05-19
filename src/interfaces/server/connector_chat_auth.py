"""Conversation-facing connector authorization helpers.

This module is intentionally a thin control-plane bridge. It can start or
complete existing connector auth actions before a Codex turn is launched, but
it does not expose legacy model-facing Ripple tools back to Codex.
"""

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from interfaces.server.sessions import Session
from ripple.connectors.base import ConnectorActionResult
from ripple.connectors.registry import get_connector, list_connectors

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
_NOTION_TOKEN_RE = re.compile(r"\b(?:ntn|secret)_[A-Za-z0-9._=-]{20,}\b")
_URL_RE = re.compile(r"https?://[^\s]+")

_CONNECTOR_KEYWORDS: dict[str, tuple[str, ...]] = {
    "google_workspace": (
        "gmail",
        "google",
        "workspace",
        "drive",
        "calendar",
        "docs",
        "sheets",
        "slides",
        "谷歌",
        "邮件",
        "日历",
    ),
    "notion": ("notion",),
    "feishu": ("feishu", "lark", "飞书", "飞書"),
    "bilibili": ("bilibili", "b站", "B站"),
}


def _action_response(result: ConnectorActionResult) -> dict[str, Any]:
    return {
        "name": result.name,
        "ok": result.ok,
        "stage": result.stage,
        "detail": result.detail,
        "data": result.data,
    }


def _event(
    *,
    connector_name: str,
    stage: str,
    message: str,
    event_type: str = "connector_auth_required",
    action: ConnectorActionResult | None = None,
    user_content: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    connector = get_connector(connector_name)
    info = connector.info if connector else None
    return {
        "type": event_type,
        "connector": connector_name,
        "display_name": info.display_name if info else connector_name,
        "auth_flow": info.auth_flow if info else "none",
        "stage": stage,
        "message": message,
        "action": _action_response(action) if action is not None else None,
        "user_content": user_content,
    }


def _find_email(text: str) -> str:
    match = _EMAIL_RE.search(text)
    return match.group(0) if match else ""


def _find_notion_token(text: str) -> str:
    match = _NOTION_TOKEN_RE.search(text)
    return match.group(0) if match else ""


def _find_google_callback_url(text: str) -> str:
    for match in _URL_RE.finditer(text):
        candidate = match.group(0).rstrip(").,，。")
        try:
            parsed = urlparse(candidate)
        except ValueError:
            continue
        query = parse_qs(parsed.query)
        if query.get("code") and query.get("state"):
            return candidate
    return ""


def _is_done_signal(text: str) -> bool:
    lowered = text.strip().lower()
    return any(token in lowered for token in ("好了", "授权好了", "扫好了", "done", "ok", "complete", "完成"))


def _mentions_connector(connector_name: str, text: str) -> bool:
    lowered = text.lower()
    return any(keyword.lower() in lowered for keyword in _CONNECTOR_KEYWORDS.get(connector_name, ()))


def _connector_connected(session: Session, connector_name: str) -> bool:
    manager = session.context.sandbox_manager if session.context else None
    connector = get_connector(connector_name)
    if manager is None or connector is None:
        return False
    try:
        return connector.status(manager.config, session.user_id).connected
    except Exception:  # noqa: BLE001
        return False


async def _run_action(
    session: Session,
    connector_name: str,
    action: str,
    payload: dict[str, Any],
    *,
    request_base_url: str | None = None,
) -> ConnectorActionResult:
    manager = session.context.sandbox_manager if session.context else None
    if manager is None:
        raise RuntimeError("sandbox disabled")
    connector = get_connector(connector_name)
    if connector is None:
        raise RuntimeError(f"connector {connector_name!r} not found")
    async with manager.user_lock(session.user_id):
        if action == "start":
            return await connector.auth_start(
                manager.config,
                session.user_id,
                payload,
                request_base_url=request_base_url,
            )
        if action == "complete":
            return await connector.auth_complete(manager.config, session.user_id, payload)
    raise RuntimeError(f"unsupported connector auth action {action!r}")


async def _start_notion(session: Session, text: str) -> dict[str, Any]:
    token = _find_notion_token(text)
    if not token:
        session.pending_connector_auth = {"connector": "notion", "stage": "awaiting_token"}
        return _event(
            connector_name="notion",
            stage="awaiting_token",
            message=(
                "Notion 还没有为当前用户授权。请把 Notion Internal Integration Token "
                "直接发在下一条消息里；Ripple 会在服务端截获并保存到当前 user sandbox，不会交给 Codex。"
            ),
        )
    result = await _run_action(session, "notion", "start", {"api_token": token})
    session.pending_connector_auth = None if result.ok else {"connector": "notion", "stage": "awaiting_token"}
    return _event(
        connector_name="notion",
        stage=result.stage,
        event_type="connector_auth_updated" if result.ok else "connector_auth_required",
        action=result,
        user_content=[{"type": "text", "text": "[Notion token redacted]"}],
        message="Notion token 已保存到当前用户的 sandbox。请重新发送刚才的 Notion 请求，我会继续处理。"
        if result.ok
        else f"Notion token 没有保存：{result.detail} 请重新发送有效 token。",
    )


async def _start_google(session: Session, text: str, *, request_base_url: str | None) -> dict[str, Any]:
    email = _find_email(text)
    if not email:
        session.pending_connector_auth = {"connector": "google_workspace", "stage": "awaiting_email"}
        return _event(
            connector_name="google_workspace",
            stage="awaiting_email",
            message="Google Workspace 还没有授权。请告诉我要绑定的 Google 邮箱地址，我会生成授权链接。",
        )
    result = await _run_action(
        session,
        "google_workspace",
        "start",
        {"email": email},
        request_base_url=request_base_url,
    )
    pending = {"connector": "google_workspace", "stage": result.stage, "email": email}
    if result.data:
        pending.update({key: value for key, value in result.data.items() if key in {"callback_mode", "oauth_url"}})
    session.pending_connector_auth = pending
    url = result.data.get("oauth_url") if isinstance(result.data, dict) else None
    message = (
        f"请打开这个 Google 授权链接完成授权：\n\n{url}\n\n授权完成后回到这里告诉我「好了」。" if url else result.detail
    )
    return _event(connector_name="google_workspace", stage=result.stage, action=result, message=message)


async def _continue_google(session: Session, text: str) -> dict[str, Any]:
    pending = session.pending_connector_auth or {}
    email = str(pending.get("email") or _find_email(text))
    callback_url = _find_google_callback_url(text)
    if callback_url and email:
        result = await _run_action(
            session,
            "google_workspace",
            "complete",
            {"email": email, "callback_url": callback_url},
        )
        session.pending_connector_auth = None if result.ok else pending
        return _event(
            connector_name="google_workspace",
            stage=result.stage,
            event_type="connector_auth_updated",
            action=result,
            message="Google Workspace 授权已完成。请重新发送刚才的请求，我会继续处理。" if result.ok else result.detail,
        )
    if _is_done_signal(text) and _connector_connected(session, "google_workspace"):
        session.pending_connector_auth = None
        return _event(
            connector_name="google_workspace",
            stage="authorized",
            event_type="connector_auth_updated",
            message="Google Workspace 已授权。请重新发送刚才的请求，我会继续处理。",
        )
    return _event(
        connector_name="google_workspace",
        stage=str(pending.get("stage") or "awaiting_browser_callback"),
        message="如果浏览器已经显示 Ripple 授权完成，请回我「好了」；如果是 manual callback，请把完整 callback URL 发回来。",
    )


async def _start_feishu(session: Session, *, request_base_url: str | None) -> dict[str, Any]:
    result = await _run_action(session, "feishu", "start", {}, request_base_url=request_base_url)
    session.pending_connector_auth = {
        "connector": "feishu",
        "stage": result.stage,
        "device_code": result.data.get("device_code") if isinstance(result.data, dict) else "",
    }
    url = (result.data.get("oauth_url") or result.data.get("setup_url")) if isinstance(result.data, dict) else ""
    message = f"请打开飞书授权链接完成授权：\n\n{url}\n\n完成后回到这里告诉我「好了」。" if url else result.detail
    return _event(connector_name="feishu", stage=result.stage, action=result, message=message)


async def _continue_feishu(session: Session, text: str) -> dict[str, Any]:
    pending = session.pending_connector_auth or {}
    device_code = str(pending.get("device_code") or "")
    if _is_done_signal(text) and device_code:
        result = await _run_action(session, "feishu", "complete", {"device_code": device_code})
        session.pending_connector_auth = None if result.stage == "authorized" else pending
        return _event(
            connector_name="feishu",
            stage=result.stage,
            event_type="connector_auth_updated",
            action=result,
            message="飞书授权已完成。请重新发送刚才的请求，我会继续处理。" if result.ok else result.detail,
        )
    return _event(
        connector_name="feishu", stage=str(pending.get("stage") or "pending"), message="飞书授权还在等待完成。"
    )


async def _start_bilibili(session: Session, *, request_base_url: str | None) -> dict[str, Any]:
    result = await _run_action(session, "bilibili", "start", {}, request_base_url=request_base_url)
    session.pending_connector_auth = {
        "connector": "bilibili",
        "stage": result.stage,
        "qrcode_key": result.data.get("qrcode_key") if isinstance(result.data, dict) else "",
    }
    qr_url = result.data.get("qrcode_image_url") if isinstance(result.data, dict) else ""
    message = (
        f"请打开这个二维码链接，用 B 站 App 扫码并确认登录：\n\n{qr_url}\n\n扫完后回到这里告诉我「好了」。"
        if qr_url
        else result.detail
    )
    return _event(connector_name="bilibili", stage=result.stage, action=result, message=message)


async def _continue_bilibili(session: Session, text: str) -> dict[str, Any]:
    pending = session.pending_connector_auth or {}
    qrcode_key = str(pending.get("qrcode_key") or "")
    if _is_done_signal(text) and qrcode_key:
        result = await _run_action(session, "bilibili", "complete", {"qrcode_key": qrcode_key, "max_wait_seconds": 30})
        session.pending_connector_auth = None if result.stage == "authorized" else pending
        return _event(
            connector_name="bilibili",
            stage=result.stage,
            event_type="connector_auth_updated",
            action=result,
            message="Bilibili 已授权。请重新发送刚才的请求，我会继续处理。" if result.ok else result.detail,
        )
    return _event(
        connector_name="bilibili",
        stage=str(pending.get("stage") or "pending"),
        message="Bilibili 扫码登录还在等待完成。",
    )


async def maybe_handle_connector_chat_auth(
    *,
    session: Session,
    user_input: str,
    request_base_url: str | None,
) -> dict[str, Any] | None:
    """Return a connector-auth event when chat should pause before Codex."""

    pending = session.pending_connector_auth or {}
    pending_connector = pending.get("connector")
    if pending_connector == "notion":
        return await _start_notion(session, user_input)
    if pending_connector == "google_workspace":
        return await _continue_google(session, user_input)
    if pending_connector == "feishu":
        return await _continue_feishu(session, user_input)
    if pending_connector == "bilibili":
        return await _continue_bilibili(session, user_input)

    for connector in list_connectors():
        if connector.info.kind != "user_connector":
            continue
        connector_name = connector.info.name
        if not connector.info.auth_surfaces.get("chat"):
            continue
        if _connector_connected(session, connector_name):
            continue
        if not _mentions_connector(connector_name, user_input):
            continue
        if connector_name == "notion":
            return await _start_notion(session, user_input)
        if connector_name == "google_workspace":
            return await _start_google(session, user_input, request_base_url=request_base_url)
        if connector_name == "feishu":
            return await _start_feishu(session, request_base_url=request_base_url)
        if connector_name == "bilibili":
            return await _start_bilibili(session, request_base_url=request_base_url)
    return None
