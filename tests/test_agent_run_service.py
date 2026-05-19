import asyncio

import pytest

from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.agent_runners.service import AgentRunNotRoutedError, resolve_workspace_cwd, start_agent_run


class RecordingProvider:
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
async def test_start_agent_run_maps_workspace_cwd_to_sandbox_metadata(tmp_path):
    provider = RecordingProvider()
    manager = ExternalAgentManager(providers={"codex": provider})
    workspace = tmp_path / "workspace"
    nested = workspace / "nested"
    nested.mkdir(parents=True)
    sandbox_config = object()

    job = start_agent_run(
        prompt="分析这个项目并实现一个多文件功能",
        provider_name="auto",
        raw_cwd="nested",
        max_runtime_seconds=300,
        user_id="alice",
        session_id="session-a",
        workspace_root=workspace,
        runtime_dir=tmp_path / "runtime",
        manager=manager,
        sandbox_config=sandbox_config,
    )
    while not provider.requests:
        await asyncio.sleep(0.01)

    request = provider.requests[0]
    assert job.provider == "codex"
    assert request.cwd == nested
    assert request.metadata["sandbox_cwd"] == "/workspace/nested"
    assert request.metadata["sandbox_config"] is sandbox_config

    manager.cancel(job.job_id)
    await manager.wait(job.job_id)


def test_start_agent_run_keeps_auto_routing_from_launching_direct_questions(tmp_path):
    manager = ExternalAgentManager(providers={"codex": RecordingProvider()})

    with pytest.raises(AgentRunNotRoutedError) as exc:
        start_agent_run(
            prompt="解释一下什么是 async await",
            provider_name="auto",
            raw_cwd=None,
            max_runtime_seconds=300,
            user_id="alice",
            session_id="session-a",
            workspace_root=tmp_path,
            runtime_dir=tmp_path / "runtime",
            manager=manager,
            sandbox_config=None,
        )

    assert exc.value.decision.route.value == "direct"
    assert manager.jobs == {}


def test_resolve_workspace_cwd_rejects_workspace_prefix_sibling(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(ValueError):
        resolve_workspace_cwd("/workspace2/project", workspace)


@pytest.mark.asyncio
async def test_start_agent_run_forwards_turn_configuration(tmp_path):
    provider = RecordingProvider()
    manager = ExternalAgentManager(providers={"codex": provider})
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    output_schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}

    job = start_agent_run(
        prompt="分析这个项目并实现一个多文件功能",
        input_items=[{"type": "text", "text": "native input"}],
        provider_name="codex",
        raw_cwd=None,
        max_runtime_seconds=300,
        user_id="alice",
        session_id="session-a",
        workspace_root=workspace,
        runtime_dir=tmp_path / "runtime",
        manager=manager,
        sandbox_config=None,
        model="gpt-5.5",
        effort="high",
        summary="detailed",
        output_schema=output_schema,
    )
    while not provider.requests:
        await asyncio.sleep(0.01)

    request = provider.requests[0]
    assert request.input_items == [{"type": "text", "text": "native input"}]
    assert request.model == "gpt-5.5"
    assert request.effort == "high"
    assert request.summary == "detailed"
    assert request.output_schema == output_schema

    manager.cancel(job.job_id)
    await manager.wait(job.job_id)
