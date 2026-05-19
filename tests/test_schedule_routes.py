import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.schedules import get_schedule, trigger_due_schedules


class RecordingProvider:
    def __init__(self, *, sleep: float = 30):
        self.sleep = sleep
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path):
        self.requests.append(request)
        if self.sleep:
            await asyncio.sleep(self.sleep)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        events_file.parent.mkdir(parents=True, exist_ok=True)
        events_file.write_text("", encoding="utf-8")
        output_file.write_text("done", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
        )


def _client(
    tmp_path: Path,
    monkeypatch,
    *,
    user_id: str = "alice",
    provider: RecordingProvider | None = None,
) -> tuple[TestClient, SessionManager, ExternalAgentManager]:
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(sandbox_config)
    session_manager = SessionManager(sandbox_manager=sandbox_manager)
    agent_manager = ExternalAgentManager(providers={"codex": provider or RecordingProvider()})
    monkeypatch.setattr("interfaces.server.routes.get_external_agent_manager", lambda: agent_manager)

    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(session_manager)
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), session_manager, agent_manager


def test_schedule_crud_routes_are_user_scoped(tmp_path: Path, monkeypatch):
    client, _session_manager, agent_manager = _client(tmp_path, monkeypatch)
    run_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

    created = client.post(
        "/v1/schedules",
        json={
            "title": "Morning digest",
            "prompt": "Summarize the repo",
            "kind": "once",
            "timezone": "UTC",
            "run_at": run_at,
            "model": "codex-medium",
        },
    )

    assert created.status_code == 200
    schedule = created.json()
    schedule_id = schedule["schedule_id"]
    assert schedule["status"] == "active"
    assert schedule["next_run_at"] is not None

    listed = client.get("/v1/schedules")
    assert listed.status_code == 200
    assert [item["schedule_id"] for item in listed.json()["schedules"]] == [schedule_id]

    bob_client = TestClient(client.app, headers={"X-Ripple-User-Id": "bob"})
    assert bob_client.get(f"/v1/schedules/{schedule_id}").status_code == 404

    patched = client.patch(f"/v1/schedules/{schedule_id}", json={"enabled": False})
    assert patched.status_code == 200
    assert patched.json()["status"] == "paused"
    assert patched.json()["next_run_at"] is None

    deleted = client.delete(f"/v1/schedules/{schedule_id}")
    assert deleted.status_code == 200
    assert client.get("/v1/schedules").json()["count"] == 0

    assert agent_manager.jobs == {}


def test_schedule_run_now_starts_codex_run_with_schedule_metadata(tmp_path: Path, monkeypatch):
    client, _session_manager, agent_manager = _client(tmp_path, monkeypatch)
    run_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    created = client.post(
        "/v1/schedules",
        json={"title": "Run now", "prompt": "Inspect files", "kind": "once", "timezone": "UTC", "run_at": run_at},
    )
    schedule_id = created.json()["schedule_id"]

    response = client.post(f"/v1/schedules/{schedule_id}/run-now")

    assert response.status_code == 200
    body = response.json()
    assert body["job_id"] in agent_manager.jobs
    assert agent_manager.jobs[body["job_id"]].metadata["schedule_id"] == schedule_id

    runs = client.get(f"/v1/schedules/{schedule_id}/runs")
    assert runs.status_code == 200
    assert runs.json()["runs"][0]["job_id"] == body["job_id"]

    client.post(f"/v1/runs/{body['job_id']}/cancel")


async def test_schedule_run_now_ignores_legacy_freeform_summary(tmp_path: Path, monkeypatch):
    provider = RecordingProvider(sleep=0)
    client, _session_manager, agent_manager = _client(tmp_path, monkeypatch, provider=provider)
    run_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    created = client.post(
        "/v1/schedules",
        json={
            "title": "Legacy summary",
            "prompt": "Inspect files",
            "kind": "interval",
            "timezone": "UTC",
            "run_at": run_at,
            "interval_seconds": 60,
        },
    )
    schedule_id = created.json()["schedule_id"]
    # Simulate a record created before schedule extraction stopped storing free-form text in summary.
    schedules_path = _session_manager.sandbox_manager.config.sandbox_dir("alice") / "schedules" / "schedules.json"
    raw = schedules_path.read_text(encoding="utf-8")
    schedules_path.write_text(
        raw.replace('"summary": null', '"summary": "free-form task description"'), encoding="utf-8"
    )

    response = client.post(f"/v1/schedules/{schedule_id}/run-now")

    assert response.status_code == 200
    await agent_manager.wait(response.json()["job_id"])
    assert provider.requests
    assert provider.requests[0].summary is None


def test_schedule_run_now_does_not_consume_interval_run_limit(tmp_path: Path, monkeypatch):
    client, session_manager, agent_manager = _client(tmp_path, monkeypatch)
    run_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    created = client.post(
        "/v1/schedules",
        json={
            "title": "Manual test",
            "prompt": "Inspect files",
            "kind": "interval",
            "timezone": "UTC",
            "run_at": run_at,
            "interval_seconds": 60,
            "max_runs": 1,
        },
    )
    schedule_id = created.json()["schedule_id"]

    response = client.post(f"/v1/schedules/{schedule_id}/run-now")

    assert response.status_code == 200
    body = response.json()
    assert body["job_id"] in agent_manager.jobs
    schedule = get_schedule(session_manager.sandbox_manager.config, "alice", schedule_id)
    assert schedule is not None
    assert schedule["run_count"] == 0
    assert schedule["max_runs"] == 1
    assert schedule["status"] == "active"

    client.post(f"/v1/runs/{body['job_id']}/cancel")


async def test_due_once_schedule_triggers_run_and_completes_schedule(tmp_path: Path, monkeypatch):
    provider = RecordingProvider(sleep=0)
    client, session_manager, agent_manager = _client(tmp_path, monkeypatch, provider=provider)
    run_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    created = client.post(
        "/v1/schedules",
        json={"title": "Due once", "prompt": "Do the work", "kind": "once", "timezone": "UTC", "run_at": run_at},
    )
    schedule_id = created.json()["schedule_id"]

    triggered = await trigger_due_schedules(
        config=session_manager.sandbox_manager.config,
        sandbox_manager=session_manager.sandbox_manager,
        agent_manager=agent_manager,
        user_id="alice",
    )

    assert triggered == [schedule_id]
    schedule = get_schedule(session_manager.sandbox_manager.config, "alice", schedule_id)
    assert schedule is not None
    assert schedule["status"] == "completed"
    assert schedule["enabled"] is False
    assert schedule["last_run_id"] in agent_manager.jobs
    assert schedule["run_count"] == 1
    await agent_manager.wait(schedule["last_run_id"])
    assert provider.requests[0].prompt == "Do the work"


async def test_due_interval_schedule_advances_next_run(tmp_path: Path, monkeypatch):
    provider = RecordingProvider(sleep=0)
    client, session_manager, agent_manager = _client(tmp_path, monkeypatch, provider=provider)
    run_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    created = client.post(
        "/v1/schedules",
        json={
            "title": "Interval",
            "prompt": "Repeat",
            "kind": "interval",
            "timezone": "UTC",
            "run_at": run_at,
            "interval_seconds": 60,
        },
    )
    schedule_id = created.json()["schedule_id"]
    original_next = created.json()["next_run_at"]

    triggered = await trigger_due_schedules(
        config=session_manager.sandbox_manager.config,
        sandbox_manager=session_manager.sandbox_manager,
        agent_manager=agent_manager,
        user_id="alice",
        now=datetime.now(timezone.utc) + timedelta(seconds=61),
    )

    assert triggered == [schedule_id]
    schedule = get_schedule(session_manager.sandbox_manager.config, "alice", schedule_id)
    assert schedule is not None
    assert schedule["status"] == "active"
    assert schedule["enabled"] is True
    assert schedule["next_run_at"] > original_next
    assert schedule["run_count"] == 1
    await agent_manager.wait(schedule["last_run_id"])


async def test_interval_schedule_completes_after_max_runs(tmp_path: Path, monkeypatch):
    provider = RecordingProvider(sleep=0)
    client, session_manager, agent_manager = _client(tmp_path, monkeypatch, provider=provider)
    base = datetime.now(timezone.utc)
    run_at = (base - timedelta(seconds=5)).isoformat()
    created = client.post(
        "/v1/schedules",
        json={
            "title": "Limited interval",
            "prompt": "Repeat twice",
            "kind": "interval",
            "timezone": "UTC",
            "run_at": run_at,
            "interval_seconds": 60,
            "max_runs": 2,
        },
    )
    schedule_id = created.json()["schedule_id"]

    first = await trigger_due_schedules(
        config=session_manager.sandbox_manager.config,
        sandbox_manager=session_manager.sandbox_manager,
        agent_manager=agent_manager,
        user_id="alice",
        now=base + timedelta(seconds=61),
    )
    first_schedule = get_schedule(session_manager.sandbox_manager.config, "alice", schedule_id)

    second = await trigger_due_schedules(
        config=session_manager.sandbox_manager.config,
        sandbox_manager=session_manager.sandbox_manager,
        agent_manager=agent_manager,
        user_id="alice",
        now=base + timedelta(seconds=121),
    )
    schedule = get_schedule(session_manager.sandbox_manager.config, "alice", schedule_id)

    assert first == [schedule_id]
    assert first_schedule is not None
    assert first_schedule["run_count"] == 1
    assert first_schedule["status"] == "active"
    assert second == [schedule_id]
    assert schedule is not None
    assert schedule["run_count"] == 2
    assert schedule["max_runs"] == 2
    assert schedule["status"] == "completed"
    assert schedule["enabled"] is False
    assert schedule["next_run_at"] is None
    await asyncio.gather(*(agent_manager.wait(job_id) for job_id in agent_manager.jobs))
    assert len(provider.requests) == 2
