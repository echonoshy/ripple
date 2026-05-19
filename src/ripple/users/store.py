"""Internal user profile and quota metadata store."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ripple.sandbox.config import SandboxConfig, validate_user_id
from ripple.utils.file_state import atomic_write_json, read_json_or_default

STATE_VERSION = 1

DEFAULT_QUOTA = {
    "max_workspace_mb": 2048,
    "max_sessions": 200,
    "max_runs_per_day": 200,
    "max_run_runtime_seconds": 3600,
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def user_meta_path(config: SandboxConfig, user_id: str) -> Path:
    validate_user_id(user_id)
    return config.sandbox_dir(user_id) / "user.json"


def default_user_record(user_id: str) -> dict[str, Any]:
    now = utc_now_iso()
    return {
        "version": STATE_VERSION,
        "user_id": user_id,
        "display_name": user_id,
        "created_at": now,
        "updated_at": now,
        "quota": dict(DEFAULT_QUOTA),
    }


def _safe_version(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return STATE_VERSION


def load_user_record(config: SandboxConfig, user_id: str) -> dict[str, Any]:
    path = user_meta_path(config, user_id)
    if path.exists():
        record = read_json_or_default(path, {})
        if isinstance(record, dict):
            merged = default_user_record(user_id)
            merged.update(record)
            merged["version"] = _safe_version(record.get("version"))
            quota = dict(DEFAULT_QUOTA)
            if isinstance(record.get("quota"), dict):
                quota.update(record["quota"])
            merged["quota"] = quota
            return merged
    return default_user_record(user_id)


def save_user_record(config: SandboxConfig, record: dict[str, Any]) -> dict[str, Any]:
    user_id = str(record["user_id"])
    path = user_meta_path(config, user_id)
    record.setdefault("version", STATE_VERSION)
    record["updated_at"] = utc_now_iso()
    atomic_write_json(path, record)
    return record


def ensure_user_record(config: SandboxConfig, user_id: str) -> dict[str, Any]:
    record = load_user_record(config, user_id)
    if not user_meta_path(config, user_id).exists():
        save_user_record(config, record)
    return record


def update_user_quota(config: SandboxConfig, user_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    record = ensure_user_record(config, user_id)
    quota = dict(record["quota"])
    for key in DEFAULT_QUOTA:
        if key in updates and updates[key] is not None:
            value = int(updates[key])
            if value < 0:
                raise ValueError(f"{key} must be >= 0")
            quota[key] = value
    record["quota"] = quota
    return save_user_record(config, record)
