"""Codex app-server approval request helpers."""

from typing import Any, Literal

ApprovalAction = Literal["allow", "always", "deny"]

_APPROVAL_METHOD_ACTIONS = {
    "item/commandExecution/requestApproval": "command_execution",
    "item/fileChange/requestApproval": "file_change",
    "item/permissions/requestApproval": "permissions",
    "execCommandApproval": "exec_command",
    "applyPatchApproval": "apply_patch",
}


def parse_codex_approval_request(
    message: dict[str, Any],
    *,
    job_id: str,
    user_id: str | None,
    session_id: str | None,
) -> dict[str, Any] | None:
    method = message.get("method")
    if not isinstance(method, str) or method not in _APPROVAL_METHOD_ACTIONS:
        return None
    request_id = message.get("id")
    if request_id is None:
        return None

    params = message.get("params")
    params = params if isinstance(params, dict) else {}
    action = _APPROVAL_METHOD_ACTIONS[method]
    description = _approval_description(action, params)

    return {
        "source": "codex",
        "job_id": job_id,
        "user_id": user_id,
        "session_id": session_id,
        "thread_id": params.get("threadId") or params.get("conversationId"),
        "turn_id": params.get("turnId"),
        "request_id": request_id,
        "method": method,
        "action": action,
        "description": description,
        "metadata": params,
    }


def codex_approval_response_for_action(approval: dict[str, Any], action: ApprovalAction) -> dict[str, Any]:
    approval_action = approval.get("action")
    if approval_action in {"command_execution", "exec_command"}:
        if action == "allow":
            return {"decision": "accept"} if approval_action == "command_execution" else {"decision": "approved"}
        if action == "always":
            return (
                {"decision": "acceptForSession"}
                if approval_action == "command_execution"
                else {"decision": "approved_for_session"}
            )
        return {"decision": "decline"} if approval_action == "command_execution" else {"decision": "denied"}

    if approval_action in {"file_change", "apply_patch"}:
        if action == "allow":
            return {"decision": "accept"} if approval_action == "file_change" else {"decision": "approved"}
        if action == "always":
            return {"decision": "acceptForSession"} if approval_action == "file_change" else {"decision": "approved"}
        return {"decision": "decline"} if approval_action == "file_change" else {"decision": "denied"}

    if approval_action == "permissions":
        if action == "deny":
            return {"permissions": {}, "scope": "turn", "strictAutoReview": True}
        metadata = approval.get("metadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        permissions = metadata.get("permissions")
        permissions = permissions if isinstance(permissions, dict) else {}
        return {
            "permissions": permissions,
            "scope": "session" if action == "always" else "turn",
            "strictAutoReview": False,
        }

    if action == "deny":
        return {"decision": "decline"}
    return {"decision": "acceptForSession" if action == "always" else "accept"}


def _approval_description(action: str, params: dict[str, Any]) -> str:
    if action in {"command_execution", "exec_command"}:
        command = params.get("command")
        if isinstance(command, list):
            return " ".join(str(part) for part in command)
        if isinstance(command, str) and command:
            return command
    if action == "file_change":
        grant_root = params.get("grantRoot")
        if isinstance(grant_root, str) and grant_root:
            return f"Allow file changes under {grant_root}"
    if action == "permissions":
        reason = params.get("reason")
        if isinstance(reason, str) and reason:
            return reason
    reason = params.get("reason")
    if isinstance(reason, str) and reason:
        return reason
    return action.replace("_", " ")
