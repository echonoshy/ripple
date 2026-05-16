"""Quota usage and enforcement helpers for internal users."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ripple.agent_runners.job_store import list_user_job_records
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import get_workspace_size_bytes
from ripple.users.store import ensure_user_record


def user_usage(config: SandboxConfig, user_id: str) -> dict[str, int]:
    records = list_user_job_records(config.sandbox_dir(user_id) / "agent-runs")
    today = datetime.now(timezone.utc).date()
    runs_today = 0
    active_runs = 0
    for record in records:
        created_at = str(record.get("created_at") or "")
        try:
            created_date = datetime.fromisoformat(created_at).date()
        except ValueError:
            created_date = None
        if created_date == today:
            runs_today += 1
        if record.get("status") == "running":
            active_runs += 1
    sessions_dir = config.sandbox_dir(user_id) / "sessions"
    session_count = len([d for d in sessions_dir.iterdir() if d.is_dir()]) if sessions_dir.exists() else 0
    return {
        "workspace_size_bytes": get_workspace_size_bytes(config, user_id),
        "session_count": session_count,
        "runs_today": runs_today,
        "active_runs": active_runs,
    }


def quota_status(config: SandboxConfig, user_id: str) -> dict[str, Any]:
    record = ensure_user_record(config, user_id)
    return {
        "user_id": user_id,
        "quota": record["quota"],
        "usage": user_usage(config, user_id),
    }


def quota_error(resource: str, *, limit: int, used: int) -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={
            "code": "quota_exceeded",
            "resource": resource,
            "limit": limit,
            "used": used,
        },
    )


def assert_can_create_run(config: SandboxConfig, user_id: str, max_runtime_seconds: int) -> None:
    status = quota_status(config, user_id)
    quota = status["quota"]
    usage = status["usage"]
    max_runs = int(quota["max_runs_per_day"])
    if usage["runs_today"] >= max_runs:
        raise quota_error("runs_per_day", limit=max_runs, used=usage["runs_today"])
    max_runtime = int(quota["max_run_runtime_seconds"])
    if max_runtime_seconds > max_runtime:
        raise quota_error("run_runtime_seconds", limit=max_runtime, used=max_runtime_seconds)


def assert_can_create_session(config: SandboxConfig, user_id: str) -> None:
    status = quota_status(config, user_id)
    max_sessions = int(status["quota"]["max_sessions"])
    used = int(status["usage"]["session_count"])
    if used >= max_sessions:
        raise quota_error("sessions", limit=max_sessions, used=used)


def assert_workspace_save_within_quota(
    config: SandboxConfig,
    user_id: str,
    target: Path,
    new_content_bytes: int,
) -> None:
    status = quota_status(config, user_id)
    max_bytes = int(status["quota"]["max_workspace_mb"]) * 1024 * 1024
    current_size = int(status["usage"]["workspace_size_bytes"])
    old_size = target.stat().st_size if target.exists() and target.is_file() else 0
    projected = current_size - old_size + new_content_bytes
    if projected > max_bytes:
        raise quota_error("workspace_bytes", limit=max_bytes, used=projected)
