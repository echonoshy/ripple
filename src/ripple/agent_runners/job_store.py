"""Durable metadata helpers for external agent runs."""

import json
from pathlib import Path
from typing import Any


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
    return {
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


def write_job_meta(job: Any) -> None:
    if job.events_file is not None:
        job_dir = job.events_file.parent
    elif job.output_file is not None:
        job_dir = job.output_file.parent
    else:
        return
    job_dir.mkdir(parents=True, exist_ok=True)
    _meta_path(job_dir).write_text(
        json.dumps(record_from_job(job), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_job_meta(job_dir: Path) -> dict[str, Any] | None:
    try:
        raw = _meta_path(job_dir).read_text(encoding="utf-8")
        record = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return None
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
