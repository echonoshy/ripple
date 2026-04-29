"""User-scoped scheduler for sandbox commands."""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from ripple.sandbox.command_runner import run_sandbox_command
from ripple.sandbox.manager import SandboxManager
from ripple.scheduler.models import ScheduledJob, ScheduledJobState, ScheduledRun, utc_now
from ripple.scheduler.store import ScheduleStore
from ripple.utils.logger import get_logger
from ripple.utils.logger import logger as root_logger
from ripple.utils.time import to_utc

logger = get_logger("scheduler.manager")

_STDIO_TAIL_CHARS = 64_000
AgentJobRunner = Callable[[ScheduledJob, ScheduledRun], Awaitable[ScheduledRun]]


class ScheduledJobRunningError(RuntimeError):
    """Raised when a destructive job operation is attempted while the job is running."""


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


def _duration_ms(started_at: datetime, finished_at: datetime) -> int:
    started = _to_utc(started_at)
    finished = _to_utc(finished_at)
    return max(0, int((finished - started).total_seconds() * 1000))


def _has_remaining_runs(job: ScheduledJob) -> bool:
    return job.max_runs is None or job.run_count < job.max_runs


def compute_followup_next_run(job: ScheduledJob, *, now: datetime | None = None) -> datetime | None:
    now = now or utc_now()
    if not job.enabled or not _has_remaining_runs(job):
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
        self._run_tasks: set[asyncio.Task] = set()
        self._state_lock = asyncio.Lock()
        self._recovered_interrupted_runs = False

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
        if self._run_tasks:
            for task in list(self._run_tasks):
                task.cancel()
            await asyncio.gather(*self._run_tasks, return_exceptions=True)
            self._run_tasks.clear()

    async def _loop(self) -> None:
        if not self._recovered_interrupted_runs:
            await self.recover_interrupted_runs()
        while True:
            await self.tick()
            await asyncio.sleep(self.poll_interval_seconds)

    async def tick(self) -> None:
        now = utc_now()
        for user_id in self.sandbox_manager.list_user_sandboxes():
            for job in self.list_jobs(user_id):
                if not job.enabled or job.next_run_at is None:
                    continue
                if job.running_at is not None or job.current_run_id is not None:
                    continue
                if _to_utc(job.next_run_at) > now:
                    continue
                key = (job.user_id, job.id)
                if key in self._running:
                    continue
                task = asyncio.create_task(self.run_job(job.user_id, job.id))
                self._run_tasks.add(task)
                task.add_done_callback(self._run_tasks.discard)

    def list_jobs(self, user_id: str) -> list[ScheduledJob]:
        return [self._hydrate_job(user_id, job) for job in self.store.list_jobs(user_id)]

    def get_job(self, user_id: str, job_id: str) -> ScheduledJob | None:
        job = self.store.get_job(user_id, job_id)
        if job is None:
            return None
        return self._hydrate_job(user_id, job)

    def create_job(self, job: ScheduledJob) -> ScheduledJob:
        now = utc_now()
        job.created_at = now
        job.updated_at = now
        state = self._state_from_job(job)
        state.next_run_at = compute_initial_next_run(job, now=now)
        self._apply_state(job, state)
        self.sandbox_manager.ensure_sandbox(job.user_id)
        created = self.store.upsert_job(job)
        self.store.save_state(job.user_id, state)
        return self._hydrate_job(job.user_id, created)

    def update_job(self, job: ScheduledJob) -> ScheduledJob:
        now = utc_now()
        job.updated_at = now
        state = self.store.get_state(job.user_id, job.id) or self._state_from_job(job)
        self._apply_state(job, state)
        if job.enabled and _has_remaining_runs(job):
            state.next_run_at = compute_initial_next_run(job, now=now)
        if not job.enabled or not _has_remaining_runs(job):
            state.next_run_at = None
        self._apply_state(job, state)
        updated = self.store.upsert_job(job)
        self.store.save_state(job.user_id, state)
        return self._hydrate_job(job.user_id, updated)

    def delete_job(self, user_id: str, job_id: str) -> bool:
        if self.store.get_job(user_id, job_id) is None:
            return False
        key = (user_id, job_id)
        state = self.store.get_state(user_id, job_id)
        if key in self._running or (state is not None and (state.running_at is not None or state.current_run_id)):
            raise ScheduledJobRunningError(f"scheduled job is running: {job_id}")
        return self.store.delete_job(user_id, job_id)

    def list_runs(self, user_id: str, job_id: str, *, limit: int = 50) -> list[ScheduledRun]:
        return self.store.list_runs(user_id, job_id, limit=limit)

    def get_run(self, user_id: str, job_id: str, run_id: str) -> ScheduledRun | None:
        return self.store.get_run(user_id, job_id, run_id)

    async def run_job(self, user_id: str, job_id: str) -> ScheduledRun | None:
        async with self._state_lock:
            job = self.store.get_job(user_id, job_id)
            if job is None:
                return None

            key = (user_id, job_id)
            state = self.store.get_state(user_id, job_id) or self._state_from_job(job)
            job = self._apply_state(job, state)
            if not _has_remaining_runs(job):
                return None
            if key in self._running or state.running_at is not None or state.current_run_id is not None:
                return None
            self._running.add(key)

            run = ScheduledRun(job_id=job.id, user_id=user_id)
            state.running_at = run.started_at
            state.current_run_id = run.id
            self.store.save_run(run)
            self.store.save_state(user_id, state)

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
                    if exit_code == 0:
                        run.status = "success"
                    elif exit_code == -1 and stderr.startswith("Command timed out after "):
                        run.status = "timeout"
                        run.error = stderr
                    else:
                        run.status = "failed"
            except asyncio.CancelledError:
                run.status = "cancelled"
                run.error = "scheduler run cancelled"
            except Exception as exc:
                logger.exception("定时任务异常: job={} error={}", job.id, exc)
                run.status = "failed"
                run.error = str(exc)
            finally:
                now = utc_now()
                run.finished_at = now
                run.duration_ms = _duration_ms(run.started_at, now)
                self.store.save_run(run)

                latest = self.store.get_job(user_id, job_id)
                if latest is not None:
                    latest_state = self.store.get_state(user_id, job_id) or self._state_from_job(latest)
                    latest = self._apply_state(latest, latest_state)
                    latest_state.running_at = None
                    latest_state.current_run_id = None
                    latest_state.last_run_at = now
                    latest_state.last_status = run.status
                    latest_state.last_error = run.error
                    latest_state.last_duration_ms = run.duration_ms
                    latest_state.run_count += 1
                    if run.status == "success":
                        latest_state.consecutive_errors = 0
                    elif run.status == "skipped":
                        latest_state.consecutive_skipped += 1
                    else:
                        latest_state.consecutive_errors += 1
                    latest = self._apply_state(latest, latest_state)
                    if latest.max_runs is not None and latest_state.run_count >= latest.max_runs:
                        latest.enabled = False
                    latest_state.next_run_at = compute_followup_next_run(latest, now=now)
                    latest.updated_at = now
                    self.store.upsert_job(latest)
                    self.store.save_state(user_id, latest_state)
                    self.store.prune_runs(user_id, job_id)

                self._running.discard(key)
                logger.info("定时任务结束: job={} run={} status={}", job.id, run.id, run.status)

        return run

    async def recover_interrupted_runs(self) -> None:
        async with self._state_lock:
            for user_id in self.sandbox_manager.list_user_sandboxes():
                states = self.store.list_states(user_id)
                for state in states.values():
                    if state.running_at is None and state.current_run_id is None:
                        continue
                    if state.current_run_id:
                        run = self.store.get_run(user_id, state.job_id, state.current_run_id)
                        if run is not None and run.status == "running":
                            now = utc_now()
                            run.status = "failed"
                            run.finished_at = now
                            run.duration_ms = _duration_ms(run.started_at, now)
                            run.error = "scheduler interrupted by server restart"
                            self.store.save_run(run)
                            state.last_run_at = now
                            state.last_status = run.status
                            state.last_error = run.error
                            state.last_duration_ms = run.duration_ms
                            state.run_count += 1
                            state.consecutive_errors += 1
                    state.running_at = None
                    state.current_run_id = None
                    job = self.store.get_job(user_id, state.job_id)
                    if job is not None:
                        job = self._apply_state(job, state)
                        if job.max_runs is not None and state.run_count >= job.max_runs:
                            job.enabled = False
                            self.store.upsert_job(job)
                        state.next_run_at = compute_followup_next_run(job, now=utc_now())
                    self.store.save_state(user_id, state)
            self._recovered_interrupted_runs = True

    def _hydrate_job(self, user_id: str, job: ScheduledJob) -> ScheduledJob:
        state = self.store.get_state(user_id, job.id) or self._state_from_job(job)
        return self._apply_state(job, state)

    def _state_from_job(self, job: ScheduledJob) -> ScheduledJobState:
        return ScheduledJobState(
            job_id=job.id,
            next_run_at=job.next_run_at,
            running_at=job.running_at,
            current_run_id=job.current_run_id,
            last_run_at=job.last_run_at,
            last_status=job.last_status,
            last_error=job.last_error,
            last_duration_ms=job.last_duration_ms,
            run_count=job.run_count,
            consecutive_errors=job.consecutive_errors,
            consecutive_skipped=job.consecutive_skipped,
            schedule_error_count=job.schedule_error_count,
            updated_at=job.updated_at,
        )

    def _apply_state(self, job: ScheduledJob, state: ScheduledJobState) -> ScheduledJob:
        job.next_run_at = state.next_run_at
        job.running_at = state.running_at
        job.current_run_id = state.current_run_id
        job.last_run_at = state.last_run_at
        job.last_status = state.last_status
        job.last_error = state.last_error
        job.last_duration_ms = state.last_duration_ms
        job.run_count = state.run_count
        job.consecutive_errors = state.consecutive_errors
        job.consecutive_skipped = state.consecutive_skipped
        job.schedule_error_count = state.schedule_error_count
        return job
