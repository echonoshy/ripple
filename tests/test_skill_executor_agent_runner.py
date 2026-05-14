import asyncio

import pytest

from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.executor import execute_forked_skill
from ripple.skills.types import Skill


class SlowCodexProvider:
    def __init__(self):
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir):
        self.requests.append(request)
        await asyncio.sleep(30)
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=job_dir / "events.jsonl",
            output_file=job_dir / "output.txt",
        )


@pytest.mark.asyncio
async def test_forked_skill_starts_codex_agent_runner(monkeypatch, tmp_path):
    provider = SlowCodexProvider()
    manager = ExternalAgentManager(providers={"codex": provider})
    monkeypatch.setattr("ripple.skills.executor.get_external_agent_manager", lambda: manager)

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    context = ToolUseContext(
        options=ToolOptions(tools=[], model="gpt-5.5", provider="openai-codex"),
        session_id="session-a",
        cwd=workspace,
        workspace_root=workspace,
        session_runtime_dir=tmp_path / "runtime",
        user_id="alice",
        sandboxed=True,
    )
    skill = Skill(
        name="deep-work",
        description="Run a delegated task",
        content="Inspect $ARGUMENTS",
        file_path=str(tmp_path / "skills" / "deep-work" / "SKILL.md"),
        context="fork",
    )

    result = await execute_forked_skill(skill, "the repo", context, parent_message=None)
    while not provider.requests:
        await asyncio.sleep(0.01)

    assert result.data["success"] is True
    assert result.data["status"] == "agent_runner"
    assert result.data["provider"] == "codex"
    assert provider.requests[0].prompt.startswith("Base directory for this skill:")
    assert "Inspect the repo" in provider.requests[0].prompt

    manager.cancel(result.data["job_id"])
    await manager.wait(result.data["job_id"])
