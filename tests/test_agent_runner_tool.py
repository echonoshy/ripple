import asyncio

import pytest

from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.tools.builtin.agent_runner import AgentRunnerTool


class SlowProvider:
    def __init__(self):
        self.steers = []
        self.requests = []

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

    def steer(self, job_id: str, text: str) -> bool:
        self.steers.append((job_id, text))
        return True


def _context(tmp_path):
    return ToolUseContext(
        options=ToolOptions(tools=[]),
        session_id="session-test",
        cwd=tmp_path,
        workspace_root=tmp_path,
        session_runtime_dir=tmp_path / "runtime",
        user_id="user-test",
        sandboxed=True,
    )


def _sandboxed_context(tmp_path):
    class DummySandboxManager:
        config = object()

    return ToolUseContext(
        options=ToolOptions(tools=[]),
        session_id="session-test",
        cwd=tmp_path / "workspace",
        workspace_root=tmp_path / "workspace",
        session_runtime_dir=tmp_path / "runtime",
        user_id="user-test",
        sandbox_manager=DummySandboxManager(),
        sandboxed=True,
    )


@pytest.mark.asyncio
async def test_agent_runner_start_status_and_cancel(tmp_path):
    provider = SlowProvider()
    manager = ExternalAgentManager(providers={"codex": provider})
    tool = AgentRunnerTool(manager=manager)

    start = await tool.call(
        {"action": "start", "prompt": "分析这个项目并实现一个多文件功能", "provider": "auto"},
        _context(tmp_path),
        None,
    )

    assert tool.name == "AgentRunner"
    assert start.data.status == "started"
    assert start.data.provider == "codex"
    assert start.data.job_id is not None

    status = await tool.call({"action": "status", "job_id": start.data.job_id}, _context(tmp_path), None)
    assert status.data.status == "running"

    steer = await tool.call(
        {"action": "steer", "job_id": start.data.job_id, "prompt": "use the simpler approach"},
        _context(tmp_path),
        None,
    )
    assert steer.data.status == "steered"
    assert provider.steers == [(start.data.job_id, "use the simpler approach")]

    cancel = await tool.call({"action": "cancel", "job_id": start.data.job_id}, _context(tmp_path), None)
    assert cancel.data.status == "cancelled"


@pytest.mark.asyncio
async def test_agent_runner_auto_does_not_launch_for_simple_direct_questions(tmp_path):
    manager = ExternalAgentManager(providers={"codex": SlowProvider()})
    tool = AgentRunnerTool(manager=manager)

    result = await tool.call(
        {"action": "start", "prompt": "解释一下什么是 async await", "provider": "auto"},
        _context(tmp_path),
        None,
    )

    assert result.data.status == "not_routed"
    assert result.data.route == "direct"
    assert manager.jobs == {}


@pytest.mark.asyncio
async def test_agent_runner_rejects_non_codex_provider(tmp_path):
    tool = AgentRunnerTool(manager=ExternalAgentManager(providers={}))

    result = await tool.call(
        {"action": "start", "prompt": "分析这个项目并实现功能", "provider": "claude-code"},
        _context(tmp_path),
        None,
    )

    assert result.data.status == "error"
    assert "Only the codex provider is supported" in result.data.message


@pytest.mark.asyncio
async def test_agent_runner_passes_sandbox_cwd_metadata_for_sandboxed_context(tmp_path):
    provider = SlowProvider()
    manager = ExternalAgentManager(providers={"codex": provider})
    tool = AgentRunnerTool(manager=manager)
    context = _sandboxed_context(tmp_path)
    (context.workspace_root / "nested").mkdir(parents=True)

    start = await tool.call(
        {
            "action": "start",
            "prompt": "分析这个项目并实现一个多文件功能",
            "provider": "auto",
            "cwd": "nested",
        },
        context,
        None,
    )
    while not provider.requests:
        await asyncio.sleep(0.01)

    assert start.data.status == "started"
    request = provider.requests[0]
    assert request.cwd == context.workspace_root / "nested"
    assert request.metadata["sandbox_cwd"] == "/workspace/nested"
    assert request.metadata["sandbox_config"] is context.sandbox_manager.config
    manager.cancel(start.data.job_id)
    await manager.wait(start.data.job_id)
