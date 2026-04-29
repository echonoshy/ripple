from datetime import datetime, timedelta, timezone

from ripple.sandbox.config import SandboxConfig
from ripple.scheduler.manager import compute_followup_next_run, compute_initial_next_run
from ripple.scheduler.models import ScheduledJob, ScheduledRun, utc_now
from ripple.scheduler.store import ScheduleStore


def test_schedule_store_is_user_scoped(tmp_path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache", nsjail_path="nsjail")
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
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache", nsjail_path="nsjail")
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


def test_agent_schedule_fields_round_trip(tmp_path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache", nsjail_path="nsjail")
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
