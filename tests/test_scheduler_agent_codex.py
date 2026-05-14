from pathlib import Path

import pytest

from interfaces.server.scheduler_agent import run_scheduled_agent_job
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.scheduler.models import ScheduledJob, ScheduledRun


class RecordingCodexProvider:
    def __init__(self, output: str = "scheduled codex output"):
        self.output = output
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        events_file.write_text("", encoding="utf-8")
        output_file = job_dir / "output.txt"
        output_file.write_text(self.output, encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail=self.output,
        )


@pytest.mark.asyncio
async def test_scheduled_agent_job_runs_through_codex_runner(tmp_path: Path, monkeypatch):
    provider = RecordingCodexProvider(output="daily report complete")
    agent_manager = ExternalAgentManager(providers={"codex": provider})
    monkeypatch.setattr("interfaces.server.scheduler_agent.get_external_agent_manager", lambda: agent_manager)

    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(sandbox_config)
    job = ScheduledJob(
        id="job-report",
        user_id="alice",
        name="Daily report",
        execution_type="agent",
        prompt="Write the daily report",
        schedule_type="once",
    )
    run = ScheduledRun(id="run-report", job_id=job.id, user_id=job.user_id)

    result = await run_scheduled_agent_job(job, run, sandbox_manager)

    assert result.status == "success"
    assert result.exit_code == 0
    assert result.summary == "daily report complete"
    assert result.stdout_tail == "daily report complete"
    assert provider.requests
    request = provider.requests[0]
    assert request.provider == "codex"
    assert request.user_id == "alice"
    assert request.metadata["sandbox_cwd"] == "/workspace"
    assert "Write the daily report" in request.prompt
