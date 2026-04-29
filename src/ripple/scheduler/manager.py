"""User-scoped scheduler for sandbox commands."""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from ripple.sandbox.command_runner import run_sandbox_command
from ripple.sandbox.manager import SandboxManager
from ripple.scheduler.models import ScheduledJob, ScheduledRun, utc_now
from ripple.scheduler.store import ScheduleStore
from ripple.utils.logger import get_logger
from ripple.utils.logger import logger as root_logger
from ripple.utils.time import to_utc

logger = get_logger("scheduler.manager")

_STDIO_TAIL_CHARS = 64_000
AgentJobRunner = Callable[[ScheduledJob, ScheduledRun], Awaitable[ScheduledRun]]


def _to_utc(value: datetime) -> datetime:
    return to_utc(value)


def compute_initial_next_run(job: ScheduledJob, *, now: datetime | None = None) -> datetime | None:
    now = now or utc_now()
    if not job.enabled:
        return None
    if job.schedule_type == "once":
        return _to_utc(job.run_at) if job.run_at else None
    if job.schedule_type == "interval":
        interval = job.interval_seconds
        if interval is None or interval <= 0:
            return None
        return now + timedelta(seconds=interval)
    return None


def compute_followup_next_run(job: ScheduledJob, *, now: datetime | None = None) -> datetime | None:
    now = now or utc_now()
    if not job.enabled:
        return None
    if job.schedule_type == "once":
        return None
    if job.schedule_type == "interval":
        interval = job.interval_seconds
        if interval is None or interval <= 0:
            return None
        base = job.next_run_at or now
        base = _to_utc(base)
        while base <= now:
            base += timedelta(seconds=interval)
        return base
    return None


class SchedulerManager:
    """Run scheduled commands for all user sandboxes."""

    def __init__(
        self,
        sandbox_manager: SandboxManager,
        *,
        poll_interval_seconds: float = 5.0,
        agent_job_runner: AgentJobRunner | None = None,
    ):
        self.sandbox_manager = sandbox_manager
        self.store = ScheduleStore(sandbox_manager.config)
        self.poll_interval_seconds = poll_interval_seconds
        self.agent_job_runner = agent_job_runner
        self._loop_task: asyncio.Task | None = None
        self._running: set[tuple[str, str]] = set()

    def start(self) -> None:
        if self._loop_task is None:
            self._loop_task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None

    async def _loop(self) -> None:
        while True:
            await self.tick()
            await asyncio.sleep(self.poll_interval_seconds)

    async def tick(self) -> None:
        now = utc_now()
        for user_id in self.sandbox_manager.list_user_sandboxes():
            for job in self.store.list_jobs(user_id):
                if not job.enabled or job.next_run_at is None:
                    continue
                if _to_utc(job.next_run_at) > now:
                    continue
                key = (job.user_id, job.id)
                if key in self._running:
                    continue
                asyncio.create_task(self.run_job(job.user_id, job.id))

    def list_jobs(self, user_id: str) -> list[ScheduledJob]:
        return self.store.list_jobs(user_id)

    def get_job(self, user_id: str, job_id: str) -> ScheduledJob | None:
        return self.store.get_job(user_id, job_id)

    def create_job(self, job: ScheduledJob) -> ScheduledJob:
        now = utc_now()
        job.created_at = now
        job.updated_at = now
        job.next_run_at = compute_initial_next_run(job, now=now)
        self.sandbox_manager.ensure_sandbox(job.user_id)
        return self.store.upsert_job(job)

    def update_job(self, job: ScheduledJob) -> ScheduledJob:
        now = utc_now()
        job.updated_at = now
        if job.enabled and job.next_run_at is None:
            job.next_run_at = compute_initial_next_run(job, now=now)
        if not job.enabled:
            job.next_run_at = None
        return self.store.upsert_job(job)

    def delete_job(self, user_id: str, job_id: str) -> bool:
        return self.store.delete_job(user_id, job_id)

    def list_runs(self, user_id: str, job_id: str, *, limit: int = 50) -> list[ScheduledRun]:
        return self.store.list_runs(user_id, job_id, limit=limit)

    def get_run(self, user_id: str, job_id: str, run_id: str) -> ScheduledRun | None:
        return self.store.get_run(user_id, job_id, run_id)

    async def run_job(self, user_id: str, job_id: str) -> ScheduledRun | None:
        job = self.store.get_job(user_id, job_id)
        if job is None:
            return None

        key = (user_id, job_id)
        if key in self._running:
            return None
        self._running.add(key)

        run = ScheduledRun(job_id=job.id, user_id=user_id)
        self.store.save_run(run)

        with root_logger.contextualize(user_id=user_id, session_id="-", request_id=f"sched-{run.id}"):
            logger.info("定时任务开始: job={} name={}", job.id, job.name)
            try:
                self.sandbox_manager.ensure_sandbox(user_id)
                if job.execution_type == "agent":
                    if self.agent_job_runner is None:
                        raise RuntimeError("agent schedule runner is not configured")
                    run = await self.agent_job_runner(job, run)
                else:
                    async with self.sandbox_manager.user_lock(user_id):
                        stdout, stderr, exit_code = await run_sandbox_command(
                            job.command,
                            self.sandbox_manager.config,
                            user_id,
                            timeout=job.timeout_seconds,
                        )
                    run.exit_code = exit_code
                    run.stdout_tail = stdout[-_STDIO_TAIL_CHARS:]
                    run.stderr_tail = stderr[-_STDIO_TAIL_CHARS:]
                    run.status = "success" if exit_code == 0 else "failed"
            except Exception as exc:
                logger.exception("定时任务异常: job={} error={}", job.id, exc)
                run.status = "failed"
                run.error = str(exc)
            finally:
                now = utc_now()
                run.finished_at = now
                self.store.save_run(run)

                latest = self.store.get_job(user_id, job_id)
                if latest is not None:
                    latest.last_run_at = now
                    latest.last_status = run.status
                    latest.next_run_at = compute_followup_next_run(latest, now=now)
                    latest.updated_at = now
                    self.store.upsert_job(latest)

                self._running.discard(key)
                logger.info("定时任务结束: job={} run={} status={}", job.id, run.id, run.status)

        return run
