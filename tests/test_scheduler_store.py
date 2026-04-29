import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from interfaces.server.scheduler_agent import run_scheduled_agent_job
from ripple.messages.types import AgentStopEvent, AssistantMessage
from ripple.sandbox.config import SandboxConfig
from ripple.scheduler.manager import (
    ScheduledJobRunningError,
    SchedulerManager,
    compute_followup_next_run,
    compute_initial_next_run,
)
from ripple.scheduler.models import ScheduledJob, ScheduledJobState, ScheduledRun, utc_now
from ripple.scheduler.store import ScheduleStore
from ripple.tools.builtin.schedule import ScheduleTool, set_schedule_tool_manager


class FakeSandboxManager:
    def __init__(self, config: SandboxConfig, user_ids: list[str] | None = None):
        self.config = config
        self.user_ids = user_ids or ["alice"]
        self._locks: dict[str, asyncio.Lock] = {}

    def list_user_sandboxes(self) -> list[str]:
        return self.user_ids

    def ensure_sandbox(self, user_id: str):
        self.config.workspace_dir(user_id).mkdir(parents=True, exist_ok=True)
        (self.config.sandbox_dir(user_id) / "sessions").mkdir(parents=True, exist_ok=True)
        return self.config.workspace_dir(user_id)

    def user_lock(self, user_id: str) -> asyncio.Lock:
        return self._locks.setdefault(user_id, asyncio.Lock())

    def list_user_sessions(self, user_id: str) -> list[str]:
        sessions_dir = self.config.sandbox_dir(user_id) / "sessions"
        if not sessions_dir.exists():
            return []
        return [path.name for path in sessions_dir.iterdir() if path.is_dir() and (path / "meta.json").exists()]


def make_config(tmp_path) -> SandboxConfig:
    return SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache", nsjail_path="nsjail")


def test_schedule_store_is_user_scoped(tmp_path):
    config = make_config(tmp_path)
    store = ScheduleStore(config)

    user_a_job = ScheduledJob(
        user_id="alice",
        name="daily",
        command="python daily.py",
        schedule_type="interval",
        interval_seconds=60,
    )
    user_b_job = ScheduledJob(
        user_id="bob",
        name="daily",
        command="python other.py",
        schedule_type="interval",
        interval_seconds=60,
    )

    store.upsert_job(user_a_job)
    store.upsert_job(user_b_job)

    assert [job.id for job in store.list_jobs("alice")] == [user_a_job.id]
    assert [job.id for job in store.list_jobs("bob")] == [user_b_job.id]
    assert store.get_job("alice", user_b_job.id) is None


def test_schedule_runs_are_user_scoped(tmp_path):
    config = make_config(tmp_path)
    store = ScheduleStore(config)

    run = ScheduledRun(job_id="job-123", user_id="alice", status="success", exit_code=0)
    store.save_run(run)

    assert store.get_run("alice", "job-123", run.id) == run
    assert store.get_run("bob", "job-123", run.id) is None


def test_interval_next_run_calculation():
    now = utc_now()
    job = ScheduledJob(
        user_id="alice",
        name="interval",
        command="date",
        schedule_type="interval",
        interval_seconds=60,
    )

    assert compute_initial_next_run(job, now=now) == now + timedelta(seconds=60)

    job.next_run_at = now - timedelta(seconds=180)
    assert compute_followup_next_run(job, now=now) == now + timedelta(seconds=60)

    job.max_runs = 3
    job.run_count = 3
    assert compute_followup_next_run(job, now=now) is None


def test_agent_schedule_fields_round_trip(tmp_path):
    config = make_config(tmp_path)
    store = ScheduleStore(config)

    job = ScheduledJob(
        user_id="alice",
        name="hydration reminder",
        prompt="Use Feishu to remind me to drink water.",
        execution_type="agent",
        created_from="chat",
        schedule_type="once",
        run_at=datetime(2026, 4, 29, 14, 5, 0),
    )
    run = ScheduledRun(
        job_id=job.id,
        user_id="alice",
        status="success",
        summary="Reminder sent.",
    )

    store.upsert_job(job)
    store.save_run(run)

    loaded = store.get_job("alice", job.id)
    assert loaded is not None
    assert loaded.execution_type == "agent"
    assert loaded.created_from == "chat"
    assert loaded.prompt == "Use Feishu to remind me to drink water."
    assert store.get_run("alice", job.id, run.id).summary == "Reminder sent."


def test_once_naive_run_at_is_interpreted_as_local_time():
    job = ScheduledJob(
        user_id="alice",
        name="once",
        command="date",
        schedule_type="once",
        run_at=datetime(2026, 4, 29, 14, 5, 0),
    )

    assert compute_initial_next_run(job, now=utc_now()) == datetime(2026, 4, 29, 6, 5, 0, tzinfo=timezone.utc)


def test_schedule_state_is_stored_separately_from_job_definition(tmp_path):
    config = make_config(tmp_path)
    store = ScheduleStore(config)
    job = ScheduledJob(
        user_id="alice",
        name="daily",
        command="date",
        schedule_type="interval",
        interval_seconds=60,
    )
    state = ScheduledJobState(
        job_id=job.id,
        next_run_at=utc_now(),
        current_run_id="run-123",
        last_status="running",
    )

    store.upsert_job(job)
    store.save_state("alice", state)

    jobs_raw = config.scheduled_jobs_file("alice").read_text(encoding="utf-8")
    assert "current_run_id" not in jobs_raw
    assert store.get_state("alice", job.id).current_run_id == "run-123"


async def test_scheduler_persists_running_marker_and_skips_concurrent_run(tmp_path):
    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)
    release = asyncio.Event()

    async def runner(job: ScheduledJob, run: ScheduledRun) -> ScheduledRun:
        state = manager.store.get_state(job.user_id, job.id)
        assert state is not None
        assert state.current_run_id == run.id
        await release.wait()
        run.status = "success"
        run.summary = "done"
        return run

    manager = SchedulerManager(sandbox_manager, agent_job_runner=runner)
    job = manager.create_job(
        ScheduledJob(
            user_id="alice",
            name="agent",
            prompt="do it",
            execution_type="agent",
            schedule_type="once",
            run_at=utc_now(),
        )
    )

    task = asyncio.create_task(manager.run_job("alice", job.id))
    await asyncio.sleep(0)
    assert await manager.run_job("alice", job.id) is None
    release.set()
    run = await task

    assert run is not None
    assert run.status == "success"
    state = manager.store.get_state("alice", job.id)
    assert state is not None
    assert state.running_at is None
    assert state.current_run_id is None
    assert state.last_status == "success"


async def test_interval_job_auto_disables_after_max_runs(tmp_path):
    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)

    async def runner(job: ScheduledJob, run: ScheduledRun) -> ScheduledRun:
        run.status = "success"
        return run

    manager = SchedulerManager(sandbox_manager, agent_job_runner=runner)
    job = manager.create_job(
        ScheduledJob(
            user_id="alice",
            name="limited",
            prompt="do it",
            execution_type="agent",
            schedule_type="interval",
            interval_seconds=60,
            max_runs=2,
        )
    )

    first = await manager.run_job("alice", job.id)
    assert first is not None
    after_first = manager.get_job("alice", job.id)
    assert after_first is not None
    assert after_first.enabled is True
    assert after_first.run_count == 1
    assert after_first.next_run_at is not None

    second = await manager.run_job("alice", job.id)
    assert second is not None
    after_second = manager.get_job("alice", job.id)
    assert after_second is not None
    assert after_second.enabled is False
    assert after_second.run_count == 2
    assert after_second.next_run_at is None
    assert await manager.run_job("alice", job.id) is None


async def test_scheduler_recovery_marks_interrupted_run_failed(tmp_path):
    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)
    manager = SchedulerManager(sandbox_manager)
    job = ScheduledJob(
        user_id="alice",
        name="agent",
        prompt="do it",
        execution_type="agent",
        schedule_type="interval",
        interval_seconds=60,
    )
    manager.store.upsert_job(job)
    run = ScheduledRun(job_id=job.id, user_id="alice", status="running")
    manager.store.save_run(run)
    manager.store.save_state(
        "alice",
        ScheduledJobState(job_id=job.id, running_at=run.started_at, current_run_id=run.id),
    )

    await manager.recover_interrupted_runs()

    recovered = manager.store.get_run("alice", job.id, run.id)
    state = manager.store.get_state("alice", job.id)
    assert recovered is not None
    assert recovered.status == "failed"
    assert recovered.error == "scheduler interrupted by server restart"
    assert state is not None
    assert state.running_at is None
    assert state.current_run_id is None
    assert state.last_status == "failed"


def test_schedule_run_retention_prunes_old_records(tmp_path):
    config = make_config(tmp_path)
    store = ScheduleStore(config)
    for index in range(5):
        store.save_run(ScheduledRun(job_id="job-123", user_id="alice", summary=str(index)))

    store.prune_runs("alice", "job-123", keep=2)

    assert len(store.list_runs("alice", "job-123", limit=10)) == 2


def test_schedule_runs_are_sorted_by_started_at_desc(tmp_path):
    config = make_config(tmp_path)
    store = ScheduleStore(config)
    oldest = ScheduledRun(
        id="run-zzzzzzzzzzzz",
        job_id="job-123",
        user_id="alice",
        summary="oldest",
        started_at=datetime(2026, 4, 29, 8, 0, tzinfo=timezone.utc),
    )
    newest = ScheduledRun(
        id="run-aaaaaaaaaaaa",
        job_id="job-123",
        user_id="alice",
        summary="newest",
        started_at=datetime(2026, 4, 29, 10, 0, tzinfo=timezone.utc),
    )
    middle = ScheduledRun(
        id="run-mmmmmmmmmmmm",
        job_id="job-123",
        user_id="alice",
        summary="middle",
        started_at=datetime(2026, 4, 29, 9, 0, tzinfo=timezone.utc),
    )
    store.save_run(oldest)
    store.save_run(newest)
    store.save_run(middle)

    runs = store.list_runs("alice", "job-123", limit=2)

    assert [run.summary for run in runs] == ["newest", "middle"]


async def test_command_timeout_records_timeout_status(tmp_path, monkeypatch):
    import ripple.scheduler.manager as scheduler_manager_module

    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)

    async def fake_run_sandbox_command(command, config, user_id, *, timeout=None):
        return "", "Command timed out after 1 seconds", -1

    monkeypatch.setattr(scheduler_manager_module, "run_sandbox_command", fake_run_sandbox_command)
    manager = SchedulerManager(sandbox_manager)
    job = manager.create_job(
        ScheduledJob(
            user_id="alice",
            name="timeout",
            command="sleep 10",
            execution_type="command",
            schedule_type="once",
            run_at=utc_now(),
            timeout_seconds=1,
        )
    )

    run = await manager.run_job("alice", job.id)

    assert run is not None
    assert run.status == "timeout"
    assert run.error == "Command timed out after 1 seconds"


async def test_delete_running_job_is_rejected(tmp_path):
    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)
    release = asyncio.Event()

    async def runner(job: ScheduledJob, run: ScheduledRun) -> ScheduledRun:
        await release.wait()
        run.status = "success"
        return run

    manager = SchedulerManager(sandbox_manager, agent_job_runner=runner)
    job = manager.create_job(
        ScheduledJob(
            user_id="alice",
            name="agent",
            prompt="do it",
            execution_type="agent",
            schedule_type="once",
            run_at=utc_now(),
        )
    )

    task = asyncio.create_task(manager.run_job("alice", job.id))
    await asyncio.sleep(0)
    with pytest.raises(ScheduledJobRunningError):
        manager.delete_job("alice", job.id)
    release.set()
    await task

    assert manager.delete_job("alice", job.id) is True


async def test_schedule_tool_rejects_invalid_update_to_once(tmp_path):
    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)
    manager = SchedulerManager(sandbox_manager)
    set_schedule_tool_manager(manager)
    job = manager.create_job(
        ScheduledJob(
            user_id="alice",
            name="interval",
            prompt="do it",
            execution_type="agent",
            schedule_type="interval",
            interval_seconds=60,
        )
    )

    class FakeContext:
        user_id = "alice"
        sandbox_session_id = "chat-session"

    tool = ScheduleTool()

    with pytest.raises(ValueError, match="run_at or delay_seconds"):
        await tool.call(
            {"action": "update", "job_id": job.id, "schedule_type": "once"},
            FakeContext(),
            None,
        )


async def test_scheduled_agent_does_not_create_session_state(tmp_path, monkeypatch):
    import interfaces.server.scheduler_agent as scheduler_agent_module

    config = make_config(tmp_path)
    sandbox_manager = FakeSandboxManager(config)
    job = ScheduledJob(
        user_id="alice",
        name="agent",
        prompt="do it",
        execution_type="agent",
        schedule_type="once",
        run_at=utc_now(),
    )
    run = ScheduledRun(job_id=job.id, user_id="alice")

    async def fake_query(*args, **kwargs):
        yield AssistantMessage(
            type="assistant",
            message={"content": [{"type": "text", "text": "done"}]},
        )
        yield AgentStopEvent(stop_reason="completed")

    monkeypatch.setattr(scheduler_agent_module, "query", fake_query)

    result = await run_scheduled_agent_job(job, run, sandbox_manager)

    assert result.status == "success"
    assert result.summary == "done"
    sessions_dir = config.sandbox_dir("alice") / "sessions"
    assert not sessions_dir.exists() or not any(sessions_dir.iterdir())
    assert (config.scheduled_runs_dir("alice") / job.id / run.id / "runtime").exists()
