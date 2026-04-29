"""Filesystem store for scheduled jobs and run records."""

import json
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.scheduler.models import ScheduledJob, ScheduledRun


class ScheduleStore:
    """Persist scheduled jobs under each user sandbox."""

    def __init__(self, config: SandboxConfig):
        self.config = config

    def _jobs_file(self, user_id: str) -> Path:
        return self.config.scheduled_jobs_file(user_id)

    def _runs_dir(self, user_id: str, job_id: str) -> Path:
        path = self.config.scheduled_runs_dir(user_id) / job_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _write_json_atomic(self, path: Path, data: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        tmp.replace(path)

    def list_jobs(self, user_id: str) -> list[ScheduledJob]:
        path = self._jobs_file(user_id)
        if not path.exists():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
        if not isinstance(raw, list):
            return []
        jobs = []
        for item in raw:
            try:
                jobs.append(ScheduledJob.model_validate(item))
            except ValueError:
                continue
        return jobs

    def save_jobs(self, user_id: str, jobs: list[ScheduledJob]) -> None:
        data = [job.model_dump(mode="json") for job in jobs]
        path = self._jobs_file(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._write_json_atomic(path, data)

    def get_job(self, user_id: str, job_id: str) -> ScheduledJob | None:
        for job in self.list_jobs(user_id):
            if job.id == job_id:
                return job
        return None

    def upsert_job(self, job: ScheduledJob) -> ScheduledJob:
        jobs = self.list_jobs(job.user_id)
        for idx, existing in enumerate(jobs):
            if existing.id == job.id:
                jobs[idx] = job
                self.save_jobs(job.user_id, jobs)
                return job
        jobs.append(job)
        self.save_jobs(job.user_id, jobs)
        return job

    def delete_job(self, user_id: str, job_id: str) -> bool:
        jobs = self.list_jobs(user_id)
        kept = [job for job in jobs if job.id != job_id]
        if len(kept) == len(jobs):
            return False
        self.save_jobs(user_id, kept)
        return True

    def save_run(self, run: ScheduledRun) -> ScheduledRun:
        path = self._runs_dir(run.user_id, run.job_id) / f"{run.id}.json"
        self._write_json_atomic(path, run.model_dump(mode="json"))
        return run

    def get_run(self, user_id: str, job_id: str, run_id: str) -> ScheduledRun | None:
        path = self.config.scheduled_runs_dir(user_id) / job_id / f"{run_id}.json"
        if not path.exists():
            return None
        try:
            return ScheduledRun.model_validate_json(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None

    def list_runs(self, user_id: str, job_id: str, *, limit: int = 50) -> list[ScheduledRun]:
        runs_dir = self.config.scheduled_runs_dir(user_id) / job_id
        if not runs_dir.exists():
            return []
        runs = []
        for path in sorted(runs_dir.glob("*.json"), reverse=True):
            try:
                runs.append(ScheduledRun.model_validate_json(path.read_text(encoding="utf-8")))
            except (ValueError, OSError):
                continue
            if len(runs) >= limit:
                break
        return runs
