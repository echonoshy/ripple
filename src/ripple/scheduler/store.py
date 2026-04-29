"""Filesystem store for scheduled jobs and run records."""

import json
import shutil
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.scheduler.models import ScheduledJob, ScheduledJobState, ScheduledRun, utc_now

_JOB_DEFINITION_EXCLUDE = {
    "next_run_at",
    "running_at",
    "current_run_id",
    "last_run_at",
    "last_status",
    "last_error",
    "last_duration_ms",
    "run_count",
    "consecutive_errors",
    "consecutive_skipped",
    "schedule_error_count",
}
DEFAULT_RUN_RETENTION = 2000


class ScheduleStore:
    """Persist scheduled jobs under each user sandbox."""

    def __init__(self, config: SandboxConfig):
        self.config = config

    def _jobs_file(self, user_id: str) -> Path:
        return self.config.scheduled_jobs_file(user_id)

    def _state_file(self, user_id: str) -> Path:
        return self.config.scheduled_tasks_dir(user_id) / "jobs-state.json"

    def _runs_dir(self, user_id: str, job_id: str) -> Path:
        path = self.config.scheduled_runs_dir(user_id) / job_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _write_json_atomic(self, path: Path, data: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        tmp.chmod(0o600)
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
        data = [job.model_dump(mode="json", exclude=_JOB_DEFINITION_EXCLUDE) for job in jobs]
        path = self._jobs_file(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.chmod(0o700)
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
        self.delete_state(user_id, job_id)
        return True

    def list_states(self, user_id: str) -> dict[str, ScheduledJobState]:
        path = self._state_file(user_id)
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        if not isinstance(raw, dict):
            return {}
        states = {}
        for job_id, item in raw.items():
            try:
                if isinstance(item, dict):
                    item.setdefault("job_id", job_id)
                state = ScheduledJobState.model_validate(item)
            except ValueError:
                continue
            states[state.job_id] = state
        return states

    def save_states(self, user_id: str, states: dict[str, ScheduledJobState]) -> None:
        path = self._state_file(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.chmod(0o700)
        data = {job_id: state.model_dump(mode="json") for job_id, state in states.items()}
        self._write_json_atomic(path, data)

    def get_state(self, user_id: str, job_id: str) -> ScheduledJobState | None:
        return self.list_states(user_id).get(job_id)

    def save_state(self, user_id: str, state: ScheduledJobState) -> ScheduledJobState:
        states = self.list_states(user_id)
        state.updated_at = utc_now()
        states[state.job_id] = state
        self.save_states(user_id, states)
        return state

    def delete_state(self, user_id: str, job_id: str) -> None:
        states = self.list_states(user_id)
        if job_id in states:
            del states[job_id]
            self.save_states(user_id, states)

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
        for path in runs_dir.glob("*.json"):
            try:
                runs.append(ScheduledRun.model_validate_json(path.read_text(encoding="utf-8")))
            except (ValueError, OSError):
                continue
        runs.sort(key=lambda run: run.started_at, reverse=True)
        return runs[:limit]

    def prune_runs(self, user_id: str, job_id: str, *, keep: int = DEFAULT_RUN_RETENTION) -> None:
        if keep <= 0:
            return
        runs_dir = self.config.scheduled_runs_dir(user_id) / job_id
        if not runs_dir.exists():
            return
        paths = sorted(runs_dir.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in paths[keep:]:
            shutil.rmtree(runs_dir / path.stem, ignore_errors=True)
            path.unlink(missing_ok=True)
