"""Normalized client-facing events derived from Codex app-server notifications."""

from typing import Any


def _notification_message(event: dict[str, Any]) -> dict[str, Any] | None:
    if event.get("type") != "codex.notification":
        return None
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    message = data.get("message")
    return message if isinstance(message, dict) else None


def _params(message: dict[str, Any]) -> dict[str, Any]:
    params = message.get("params")
    return params if isinstance(params, dict) else {}


def _item(params: dict[str, Any]) -> dict[str, Any] | None:
    item = params.get("item")
    return item if isinstance(item, dict) else None


def _str_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _base_event(event_type: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    item = _item(params)
    item_id = params.get("itemId") or params.get("item_id")
    if not isinstance(item_id, str) and item is not None:
        item_id = item.get("id")
    payload: dict[str, Any] = {
        "type": event_type,
        "codex_method": method,
        "thread_id": _str_value(params.get("threadId") or params.get("thread_id")),
        "turn_id": _str_value(params.get("turnId") or params.get("turn_id")),
    }
    if isinstance(item_id, str) and item_id:
        payload["id"] = item_id
    return payload


def _message_text(params: dict[str, Any]) -> str:
    for key in ("message", "warning", "error", "detail", "details"):
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _delta_text(params: dict[str, Any]) -> str:
    for key in ("delta", "output", "chunk", "text"):
        value = params.get(key)
        if isinstance(value, str):
            return value
    return ""


def _tool_delta_event(method: str, params: dict[str, Any], *, kind: str) -> dict[str, Any]:
    payload = _base_event("tool_output_delta", method, params)
    payload["kind"] = kind
    payload["delta"] = _delta_text(params)
    stream = params.get("stream")
    if isinstance(stream, str) and stream:
        payload["stream"] = stream
    return payload


def _context_compaction_event(method: str, params: dict[str, Any]) -> dict[str, Any]:
    payload = _base_event("context_compaction", method, params)
    item = _item(params)
    if item is not None:
        status = item.get("status")
        if isinstance(status, str) and status:
            payload["status"] = status
    return payload


def extract_codex_runtime_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Return a stable SSE payload for Codex notifications Ripple does not otherwise map."""

    message = _notification_message(event)
    if message is None:
        return None
    method = message.get("method")
    if not isinstance(method, str) or not method:
        return None
    params = _params(message)

    if method == "turn/diff/updated":
        payload = _base_event("codex_turn_diff_updated", method, params)
        if "diff" in params:
            payload["diff"] = params.get("diff")
        else:
            payload["params"] = params
        return payload

    if method in {"item/commandExecution/outputDelta", "item/commandExecution/delta"}:
        return _tool_delta_event(method, params, kind="command_execution")

    if method in {"item/fileChange/outputDelta", "item/fileChange/delta"}:
        return _tool_delta_event(method, params, kind="file_change")

    if method == "item/fileChange/patchUpdated":
        payload = _base_event("file_change_patch_updated", method, params)
        for key in ("patch", "changes", "status"):
            if key in params:
                payload[key] = params.get(key)
        return payload

    if method in {"warning", "configWarning", "deprecationNotice", "guardianWarning", "turn/warning"}:
        payload = _base_event("codex_warning", method, params)
        payload["message"] = _message_text(params)
        return payload

    if method in {"error", "turn/error"}:
        payload = _base_event("codex_error", method, params)
        payload["message"] = _message_text(params)
        return payload

    if method in {"thread/compacted", "thread/contextCompacted", "context/compacted"}:
        return _context_compaction_event(method, params)

    item = _item(params)
    if item is not None and item.get("type") == "contextCompaction":
        return _context_compaction_event(method, params)

    return None
