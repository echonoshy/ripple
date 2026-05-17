import asyncio
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from ripple.agent_runners.job_store import write_job_meta
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


class DummySessionManager:
    def __init__(self, sandbox_manager):
        self.sandbox_manager = sandbox_manager


class SlowProvider:
    def __init__(self):
        self.pending_approval = None

    async def run(self, request: AgentRunnerRequest, *, job_dir):
        await asyncio.sleep(30)
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=job_dir / "events.jsonl",
            output_file=job_dir / "output.txt",
        )

    def get_pending_approval(self, job_id: str):
        return self.pending_approval


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


def test_agent_run_status_includes_pending_approval(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)
    start = client.post("/v1/runs", json={"prompt": "needs approval", "provider": "codex"})
    job_id = start.json()["job_id"]
    provider = agent_manager.providers["codex"]
    provider.pending_approval = {
        "source": "codex",
        "job_id": job_id,
        "request_id": "approval-1",
        "description": "rm -rf build",
    }

    response = client.get(f"/v1/runs/{job_id}")

    assert response.status_code == 200
    assert response.json()["pending_approval"]["request_id"] == "approval-1"
    client.post(f"/v1/runs/{job_id}/cancel")


def test_agent_run_list_returns_current_user_runs(tmp_path: Path, monkeypatch):
    alice_client, _agent_manager = _client(tmp_path, monkeypatch, user_id="alice")
    bob_client = TestClient(alice_client.app, headers={"X-Ripple-User-Id": "bob"})

    alice_start = alice_client.post("/v1/runs", json={"prompt": "alice run", "provider": "codex"})
    bob_start = bob_client.post("/v1/runs", json={"prompt": "bob run", "provider": "codex"})

    alice_response = alice_client.get("/v1/runs")

    assert alice_start.status_code == 200
    assert bob_start.status_code == 200
    assert alice_response.status_code == 200
    jobs = alice_response.json()["runs"]
    assert [job["job_id"] for job in jobs] == [alice_start.json()["job_id"]]

    alice_client.post(f"/v1/runs/{alice_start.json()['job_id']}/cancel")
    bob_client.post(f"/v1/runs/{bob_start.json()['job_id']}/cancel")


def test_agent_run_status_survives_missing_live_registry(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)
    start = client.post("/v1/runs", json={"prompt": "durable run", "provider": "codex"})
    job_id = start.json()["job_id"]
    job = agent_manager.get(job_id)
    assert job is not None
    job.status = AgentRunnerStatus.COMPLETED
    write_job_meta(job)
    agent_manager.jobs.clear()

    response = client.get(f"/v1/runs/{job_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["job_id"] == job_id
    assert body["status"] == "completed"


def test_agent_run_cancel_and_steer_require_live_job(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)
    start = client.post("/v1/runs", json={"prompt": "durable run", "provider": "codex"})
    job_id = start.json()["job_id"]
    job = agent_manager.get(job_id)
    assert job is not None
    write_job_meta(job)
    agent_manager.jobs.clear()

    steer = client.post(f"/v1/runs/{job_id}/steer", json={"prompt": "continue"})
    cancel = client.post(f"/v1/runs/{job_id}/cancel")

    assert steer.status_code == 409
    assert cancel.status_code == 409


def test_agent_run_events_replays_existing_events(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)
    start = client.post("/v1/runs", json={"prompt": "events run", "provider": "codex"})
    job_id = start.json()["job_id"]
    job = agent_manager.get(job_id)
    assert job is not None
    job.events_file.parent.mkdir(parents=True, exist_ok=True)
    job.events_file.write_text(
        "\n".join(
            [
                json.dumps({"type": "started", "job_id": job_id}),
                "{not-json",
                json.dumps({"type": "completed", "job_id": job_id}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    job.status = AgentRunnerStatus.COMPLETED
    write_job_meta(job)

    with client.stream("GET", f"/v1/runs/{job_id}/events?follow=false") as response:
        body = response.read().decode()

    assert response.status_code == 200
    assert '"type": "started"' in body
    assert '"type": "completed"' in body
    assert "{not-json" not in body
    assert "data: [DONE]" in body


def test_agent_run_events_emit_normalized_plan_updates(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)
    start = client.post("/v1/runs", json={"prompt": "events run", "provider": "codex"})
    job_id = start.json()["job_id"]
    job = agent_manager.get(job_id)
    assert job is not None
    job.events_file.parent.mkdir(parents=True, exist_ok=True)
    job.events_file.write_text(
        json.dumps(
            {
                "type": "codex.notification",
                "job_id": job_id,
                "data": {
                    "message": {
                        "method": "turn/plan/updated",
                        "params": {
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "plan": [
                                {"step": "Inspect", "status": "completed"},
                                {"step": "Implement", "status": "inProgress"},
                            ],
                        },
                    }
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    job.status = AgentRunnerStatus.COMPLETED
    write_job_meta(job)

    with client.stream("GET", f"/v1/runs/{job_id}/events?follow=false") as response:
        body = response.read().decode()

    assert response.status_code == 200
    assert '"type": "codex.notification"' in body
    assert '"type": "task_plan_updated"' in body
    assert '"currentTask": "Implement"' in body
    assert '"allCompleted": false' in body


def test_agent_run_events_replay_disk_only_run(tmp_path: Path, monkeypatch):
    client, agent_manager = _client(tmp_path, monkeypatch)
    start = client.post("/v1/runs", json={"prompt": "events run", "provider": "codex"})
    job_id = start.json()["job_id"]
    job = agent_manager.get(job_id)
    assert job is not None
    job.events_file.parent.mkdir(parents=True, exist_ok=True)
    job.events_file.write_text(
        json.dumps({"type": "disk_event", "job_id": job_id}) + "\n",
        encoding="utf-8",
    )
    job.status = AgentRunnerStatus.COMPLETED
    write_job_meta(job)
    agent_manager.jobs.clear()

    with client.stream("GET", f"/v1/runs/{job_id}/events") as response:
        body = response.read().decode()

    assert response.status_code == 200
    assert '"type": "disk_event"' in body
    assert "data: [DONE]" in body


def test_agent_run_events_are_user_scoped(tmp_path: Path, monkeypatch):
    alice_client, _agent_manager = _client(tmp_path, monkeypatch, user_id="alice")
    bob_client = TestClient(alice_client.app, headers={"X-Ripple-User-Id": "bob"})
    start = alice_client.post("/v1/runs", json={"prompt": "events run", "provider": "codex"})
    job_id = start.json()["job_id"]

    response = bob_client.get(f"/v1/runs/{job_id}/events")

    assert response.status_code == 404
    alice_client.post(f"/v1/runs/{job_id}/cancel")
