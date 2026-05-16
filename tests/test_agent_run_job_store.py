from pathlib import Path

from ripple.agent_runners.job_store import (
    find_user_job_record,
    list_user_job_records,
    read_job_meta,
    write_job_meta,
)
from ripple.agent_runners.manager import ExternalAgentJob
from ripple.agent_runners.models import AgentRunnerResult, AgentRunnerStatus


def test_write_job_meta_persists_running_job(tmp_path: Path):
    job_dir = tmp_path / "agent-runs" / "external-agents" / "agent-1"
    job = ExternalAgentJob(
        job_id="agent-1",
        provider="codex",
        prompt="Analyze the workspace and make a plan",
        cwd=tmp_path / "workspace",
        user_id="alice",
        events_file=job_dir / "events.jsonl",
        output_file=job_dir / "output.txt",
    )

    write_job_meta(job)

    record = read_job_meta(job_dir)
    assert record is not None
    assert record["job_id"] == "agent-1"
    assert record["provider"] == "codex"
    assert record["user_id"] == "alice"
    assert record["prompt_preview"] == "Analyze the workspace and make a plan"
    assert record["status"] == "queued"
    assert record["events_file"] == str(job_dir / "events.jsonl")
    assert record["output_file"] == str(job_dir / "output.txt")


def test_write_job_meta_updates_completed_result(tmp_path: Path):
    job_dir = tmp_path / "agent-runs" / "external-agents" / "agent-1"
    job = ExternalAgentJob(
        job_id="agent-1",
        provider="codex",
        prompt="x" * 300,
        cwd=tmp_path / "workspace",
        user_id="alice",
        status=AgentRunnerStatus.RUNNING,
        events_file=job_dir / "events.jsonl",
        output_file=job_dir / "output.txt",
    )
    write_job_meta(job)

    job.apply_result(
        AgentRunnerResult(
            job_id="agent-1",
            provider="codex",
            status=AgentRunnerStatus.COMPLETED,
            events_file=job_dir / "events.jsonl",
            output_file=job_dir / "output.txt",
            exit_code=0,
        )
    )
    write_job_meta(job)

    record = read_job_meta(job_dir)
    assert record is not None
    assert record["status"] == "completed"
    assert record["exit_code"] == 0
    assert record["prompt_preview"] == ("x" * 240)


def test_list_user_job_records_ignores_invalid_entries_and_sorts(tmp_path: Path):
    agent_runs_dir = tmp_path / "agent-runs"
    first_dir = agent_runs_dir / "external-agents" / "agent-1"
    second_dir = agent_runs_dir / "external-agents" / "agent-2"
    corrupt_dir = agent_runs_dir / "external-agents" / "agent-corrupt"
    empty_dir = agent_runs_dir / "external-agents" / "agent-empty"
    first_dir.mkdir(parents=True)
    second_dir.mkdir(parents=True)
    corrupt_dir.mkdir(parents=True)
    empty_dir.mkdir(parents=True)
    (first_dir / "meta.json").write_text(
        '{"job_id":"agent-1","updated_at":"2026-05-16T00:00:00+00:00"}',
        encoding="utf-8",
    )
    (second_dir / "meta.json").write_text(
        '{"job_id":"agent-2","updated_at":"2026-05-16T00:01:00+00:00"}',
        encoding="utf-8",
    )
    (corrupt_dir / "meta.json").write_text("{not-json", encoding="utf-8")

    records = list_user_job_records(agent_runs_dir)

    assert [record["job_id"] for record in records] == ["agent-2", "agent-1"]
    assert find_user_job_record(agent_runs_dir, "agent-1")["job_id"] == "agent-1"
    assert find_user_job_record(agent_runs_dir, "missing") is None
