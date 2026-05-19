"""Durable metadata helpers for external agent runs."""

from pathlib import Path
from typing import Any

from ripple.utils.file_state import atomic_write_json, read_json_or_default

STATE_VERSION = 1


def _meta_path(job_dir: Path) -> Path:
    return job_dir / "meta.json"


def _path_value(path: Path | None) -> str | None:
    return str(path) if path is not None else None


def _iso_value(value: Any) -> str:
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def record_from_job(job: Any) -> dict[str, Any]:
    metadata = getattr(job, "metadata", {}) or {}
    status = getattr(job, "status", "")
    status_value = getattr(status, "value", str(status))
    record = {
        "version": STATE_VERSION,
        "job_id": job.job_id,
        "provider": job.provider,
        "user_id": job.user_id,
        "session_id": getattr(job, "session_id", None),
        "prompt_preview": job.prompt[:240],
        "cwd": str(job.cwd),
        "sandbox_cwd": metadata.get("sandbox_cwd"),
        "status": status_value,
        "created_at": _iso_value(job.created_at),
        "updated_at": _iso_value(job.updated_at),
        "events_file": _path_value(job.events_file),
        "output_file": _path_value(job.output_file),
        "exit_code": job.exit_code,
        "stdout_tail": job.stdout_tail,
        "stderr_tail": job.stderr_tail,
        "error": job.error,
    }
    for key in ("schedule_id", "schedule_title", "schedule_trigger"):
        value = metadata.get(key)
        if isinstance(value, str):
            record[key] = value
    return record


def write_job_meta(job: Any) -> None:
    if job.events_file is not None:
        job_dir = job.events_file.parent
    elif job.output_file is not None:
        job_dir = job.output_file.parent
    else:
        return
    atomic_write_json(_meta_path(job_dir), record_from_job(job))


def read_job_meta(job_dir: Path) -> dict[str, Any] | None:
    record = read_json_or_default(_meta_path(job_dir), None)
    if not isinstance(record, dict):
        return None
    record.setdefault("version", STATE_VERSION)
    return record if isinstance(record, dict) else None


def list_user_job_records(agent_runs_dir: Path) -> list[dict[str, Any]]:
    external_agents_dir = agent_runs_dir / "external-agents"
    if not external_agents_dir.exists():
        return []

    records: list[dict[str, Any]] = []
    for job_dir in external_agents_dir.iterdir():
        if not job_dir.is_dir():
            continue
        record = read_job_meta(job_dir)
        if record is not None:
            records.append(record)
    return sorted(records, key=lambda record: str(record.get("updated_at") or ""), reverse=True)


def find_user_job_record(agent_runs_dir: Path, job_id: str) -> dict[str, Any] | None:
    job_dir = agent_runs_dir / "external-agents" / job_id
    record = read_job_meta(job_dir)
    if record is None or record.get("job_id") != job_id:
        return None
    return record
