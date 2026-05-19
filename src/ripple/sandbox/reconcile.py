"""Repair stale file-backed runtime state after a server restart."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import list_all_user_ids, list_user_sessions
from ripple.utils.file_state import atomic_write_json, read_json_or_default
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.reconcile")

ACTIVE_SESSION_STATUSES = {
    "running",
    "awaiting_permission",
    "awaiting_user_input",
    "waiting_for_approval",
    "waiting_for_user",
}
ACTIVE_RUN_STATUSES = {"queued", "running"}
RESTART_ERROR = "server restarted while runtime state was active"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_dict(path: Path) -> dict[str, Any] | None:
    data = read_json_or_default(path, None)
    return data if isinstance(data, dict) else None


def _reconcile_session_meta(path: Path) -> bool:
    meta = _load_dict(path)
    if meta is None:
        return False
    if str(meta.get("status") or "").lower() not in ACTIVE_SESSION_STATUSES:
        return False

    now = _now_iso()
    meta["status"] = "failed"
    meta["error"] = RESTART_ERROR
    meta["interrupted_at"] = now
    meta["last_active"] = now
    meta["pending_question"] = None
    meta["pending_options"] = None
    meta["pending_permission_request"] = None
    atomic_write_json(path, meta)
    return True


def _reconcile_run_meta(path: Path) -> bool:
    meta = _load_dict(path)
    if meta is None:
        return False
    if str(meta.get("status") or "").lower() not in ACTIVE_RUN_STATUSES:
        return False

    now = _now_iso()
    meta["status"] = "failed"
    meta["error"] = RESTART_ERROR
    meta["updated_at"] = now
    meta["interrupted_at"] = now
    atomic_write_json(path, meta)
    return True


def reconcile_stale_runtime_state(config: SandboxConfig) -> dict[str, int]:
    """Mark file-backed running state as failed after process memory was lost."""
    summary = {"sessions": 0, "runs": 0}
    for user_id in list_all_user_ids(config):
        for session_id in list_user_sessions(config, user_id):
            meta_file = config.meta_file(user_id, session_id)
            if _reconcile_session_meta(meta_file):
                summary["sessions"] += 1

        runs_root = config.sandbox_dir(user_id) / "agent-runs" / "external-agents"
        if not runs_root.exists():
            continue
        for run_dir in runs_root.iterdir():
            if not run_dir.is_dir():
                continue
            if _reconcile_run_meta(run_dir / "meta.json"):
                summary["runs"] += 1

    if summary["sessions"] or summary["runs"]:
        logger.warning(
            "reconciled stale runtime state: sessions={} runs={}",
            summary["sessions"],
            summary["runs"],
        )
    return summary
