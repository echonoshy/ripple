"""Internal user profile and quota metadata store."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ripple.sandbox.config import SandboxConfig, validate_user_id

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
        "user_id": user_id,
        "display_name": user_id,
        "created_at": now,
        "updated_at": now,
        "quota": dict(DEFAULT_QUOTA),
    }


def load_user_record(config: SandboxConfig, user_id: str) -> dict[str, Any]:
    path = user_meta_path(config, user_id)
    if path.exists():
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            record = {}
        if isinstance(record, dict):
            merged = default_user_record(user_id)
            merged.update(record)
            quota = dict(DEFAULT_QUOTA)
            if isinstance(record.get("quota"), dict):
                quota.update(record["quota"])
            merged["quota"] = quota
            return merged
    return default_user_record(user_id)


def save_user_record(config: SandboxConfig, record: dict[str, Any]) -> dict[str, Any]:
    user_id = str(record["user_id"])
    path = user_meta_path(config, user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    record["updated_at"] = utc_now_iso()
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
