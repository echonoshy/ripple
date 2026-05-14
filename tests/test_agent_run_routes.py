import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


class DummySessionManager:
    def __init__(self, sandbox_manager):
        self.sandbox_manager = sandbox_manager


class SlowProvider:
    async def run(self, request: AgentRunnerRequest, *, job_dir):
        await asyncio.sleep(30)
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=job_dir / "events.jsonl",
            output_file=job_dir / "output.txt",
        )


def _client(tmp_path: Path, monkeypatch, user_id: str = "alice") -> tuple[TestClient, ExternalAgentManager]:
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(config)
    sandbox_manager.ensure_sandbox(user_id)
    agent_manager = ExternalAgentManager(providers={"codex": SlowProvider()})
    monkeypatch.setattr("interfaces.server.routes.get_external_agent_manager", lambda: agent_manager)

    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(DummySessionManager(sandbox_manager))
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), agent_manager


def test_agent_run_routes_start_status_steer_and_cancel(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)

    start = client.post(
        "/v1/runs",
        json={
            "prompt": "分析这个项目并实现一个多文件功能",
            "provider": "codex",
            "cwd": "/workspace",
            "max_runtime_seconds": 300,
        },
    )

    assert start.status_code == 200
    body = start.json()
    job_id = body["job_id"]
    assert body["status"] == "running"
    assert body["provider"] == "codex"

    status = client.get(f"/v1/runs/{job_id}")
    assert status.status_code == 200
    assert status.json()["job_id"] == job_id

    steer = client.post(f"/v1/runs/{job_id}/steer", json={"prompt": "focus on tests"})
    assert steer.status_code == 200
    assert steer.json()["job_id"] == job_id

    cancel = client.post(f"/v1/runs/{job_id}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelled"

    assert agent_manager.get(job_id).user_id == "alice"


def test_agent_run_routes_are_user_scoped(tmp_path: Path, monkeypatch):
    alice_client, _agent_manager = _client(tmp_path, monkeypatch, user_id="alice")
    bob_client = TestClient(
        alice_client.app,
        headers={"X-Ripple-User-Id": "bob"},
    )

    start = alice_client.post("/v1/runs", json={"prompt": "分析这个项目并实现一个功能", "provider": "codex"})
    job_id = start.json()["job_id"]

    response = bob_client.get(f"/v1/runs/{job_id}")

    assert response.status_code == 404
