import json
import sys
from pathlib import Path

import pytest

from ripple.agent_runners.codex_app_server import CodexAppServerAgentProvider
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerStatus


def _write_fake_app_server(path: Path) -> None:
    path.write_text(
        """
import json
import os
import sys

log_file = os.environ["FAKE_APP_SERVER_LOG"]
process_file = os.environ["FAKE_APP_SERVER_PROCESSES"]
thread_counter = 0
turn_counter = 0
turns = {}


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()


def record(payload):
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps({"pid": os.getpid(), **payload}) + "\\n")


with open(process_file, "a", encoding="utf-8") as f:
    f.write(str(os.getpid()) + "\\n")

for raw_line in sys.stdin:
    message = json.loads(raw_line)
    method = message.get("method")
    params = message.get("params", {})
    record({"method": method, "params": params, "has_jsonrpc": "jsonrpc" in message})

    if method == "initialize":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "fake-codex"}}})
    elif method == "initialized":
        pass
    elif method == "thread/start":
        thread_counter += 1
        thread_id = f"thr-{thread_counter}"
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"thread": {"id": thread_id}}})
        emit({"jsonrpc": "2.0", "method": "thread/started", "params": {"thread": {"id": thread_id}}})
    elif method == "turn/start":
        turn_counter += 1
        thread_id = params["threadId"]
        turn_id = f"turn-{turn_counter}"
        text = params["input"][0]["text"]
        turns[turn_id] = thread_id
        emit({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {"turn": {"id": turn_id, "status": "inProgress", "items": [], "error": None}},
        })
        emit({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "delta": f"reply:{text}"},
        })
        if "sleep" not in text:
            emit({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {"threadId": thread_id, "turnId": turn_id, "turn": {"id": turn_id, "status": "completed"}},
            })
    elif method == "turn/interrupt":
        turn_id = params["turnId"]
        thread_id = params["threadId"]
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"ok": True}})
        emit({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turnId": turn_id, "turn": {"id": turn_id, "status": "interrupted"}},
        })
    elif method == "turn/steer":
        turn_id = params["expectedTurnId"]
        thread_id = params["threadId"]
        text = params["input"][0]["text"]
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"turnId": turn_id}})
        emit({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "delta": f"steered:{text}"},
        })
""",
        encoding="utf-8",
    )


def _provider(tmp_path: Path) -> CodexAppServerAgentProvider:
    script = tmp_path / "fake_app_server.py"
    _write_fake_app_server(script)
    return CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(script)],
        env={
            "FAKE_APP_SERVER_LOG": str(tmp_path / "app-server.jsonl"),
            "FAKE_APP_SERVER_PROCESSES": str(tmp_path / "processes.txt"),
        },
        idle_timeout_seconds=60,
    )


def _request(tmp_path: Path, *, prompt: str, user_id: str = "user-a") -> AgentRunnerRequest:
    return AgentRunnerRequest(
        provider="codex",
        prompt=prompt,
        cwd=tmp_path / user_id / "workspace",
        max_runtime_seconds=5,
        user_id=user_id,
        session_id="session-test",
    )


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.asyncio
async def test_app_server_provider_runs_thread_turn_and_records_events(tmp_path):
    provider = _provider(tmp_path)
    request = _request(tmp_path, prompt="inspect project")
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    assert result.output_file is not None
    assert "reply:inspect project" in result.output_file.read_text(encoding="utf-8")

    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    assert [call["method"] for call in calls] == ["initialize", "initialized", "thread/start", "turn/start"]
    assert all(call["has_jsonrpc"] is False for call in calls)
    turn_start = calls[3]["params"]
    assert turn_start["cwd"] == str(request.cwd)
    assert turn_start["approvalPolicy"] == "never"
    assert turn_start["sandboxPolicy"]["type"] == "workspaceWrite"
    assert turn_start["sandboxPolicy"]["writableRoots"] == [str(request.cwd)]
    assert turn_start["sandboxPolicy"]["networkAccess"] is True

    events = _read_jsonl(result.events_file)
    assert "runner.started" in [event["type"] for event in events]
    assert "codex.notification" in [event["type"] for event in events]
    assert "runner.completed" in [event["type"] for event in events]


@pytest.mark.asyncio
async def test_app_server_provider_uses_sandbox_cwd_when_present(tmp_path):
    provider = _provider(tmp_path)
    request = _request(tmp_path, prompt="inspect nested project")
    request.cwd.mkdir(parents=True)
    request = request.model_copy(update={"metadata": {"sandbox_cwd": "/workspace/nested"}})

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert turn_start["params"]["cwd"] == "/workspace/nested"
    assert turn_start["params"]["sandboxPolicy"]["writableRoots"] == ["/workspace/nested"]


@pytest.mark.asyncio
async def test_app_server_provider_wraps_process_with_nsjail_when_sandbox_config_is_present(tmp_path, monkeypatch):
    script = tmp_path / "fake_app_server.py"
    _write_fake_app_server(script)
    captured = {}

    def fake_build_nsjail_argv(config, user_id, command):
        captured["config"] = config
        captured["user_id"] = user_id
        captured["command"] = command
        return [sys.executable, str(script)]

    monkeypatch.setattr("ripple.sandbox.nsjail_config.build_nsjail_argv", fake_build_nsjail_argv)
    sandbox_config = object()
    provider = CodexAppServerAgentProvider(
        codex_executable="codex",
        app_server_args=["app-server", "--listen", "stdio://"],
        env={
            "FAKE_APP_SERVER_LOG": str(tmp_path / "app-server.jsonl"),
            "FAKE_APP_SERVER_PROCESSES": str(tmp_path / "processes.txt"),
        },
    )
    request = _request(tmp_path, prompt="inspect sandboxed project")
    request.cwd.mkdir(parents=True)
    request = request.model_copy(update={"metadata": {"sandbox_config": sandbox_config, "sandbox_cwd": "/workspace"}})

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    assert captured == {
        "config": sandbox_config,
        "user_id": "user-a",
        "command": "codex app-server --listen stdio://",
    }


@pytest.mark.asyncio
async def test_app_server_pool_is_scoped_by_user_id(tmp_path):
    provider = _provider(tmp_path)
    for user_id in ("user-a", "user-a", "user-b"):
        request = _request(tmp_path, prompt=f"task for {user_id}", user_id=user_id)
        request.cwd.mkdir(parents=True, exist_ok=True)
        result = await provider.run(request, job_dir=tmp_path / f"job-{user_id}-{len(provider.pool.sessions)}")
        assert result.status == AgentRunnerStatus.COMPLETED

    pids = (tmp_path / "processes.txt").read_text(encoding="utf-8").splitlines()
    assert len(set(pids)) == 2


@pytest.mark.asyncio
async def test_manager_can_stop_one_users_app_server_without_stopping_others(tmp_path):
    provider = _provider(tmp_path)
    manager = ExternalAgentManager(providers={"codex": provider})
    for user_id in ("user-a", "user-b"):
        request = _request(tmp_path, prompt=f"task for {user_id}", user_id=user_id)
        request.cwd.mkdir(parents=True, exist_ok=True)
        result = await provider.run(request, job_dir=tmp_path / f"job-{user_id}")
        assert result.status == AgentRunnerStatus.COMPLETED

    await manager.stop_user("user-a")

    assert "user-a" not in provider.pool.sessions
    assert "user-b" in provider.pool.sessions


@pytest.mark.asyncio
async def test_manager_cancel_sends_turn_interrupt_to_app_server(tmp_path):
    provider = _provider(tmp_path)
    manager = ExternalAgentManager(providers={"codex": provider})
    request = _request(tmp_path, prompt="sleep until cancelled")
    request.cwd.mkdir(parents=True)

    job = manager.start(request, runtime_dir=tmp_path / "runtime")
    while job.job_id not in provider.active_turns:
        await provider.wait_for_active_turn(job.job_id, timeout=2)
    assert manager.cancel(job.job_id) is True

    result = await manager.wait(job.job_id)

    assert result is not None
    assert result.status == AgentRunnerStatus.CANCELLED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    assert "turn/interrupt" in [call["method"] for call in calls]


@pytest.mark.asyncio
async def test_manager_steer_sends_turn_steer_to_app_server(tmp_path):
    provider = _provider(tmp_path)
    manager = ExternalAgentManager(providers={"codex": provider})
    request = _request(tmp_path, prompt="sleep while user adds context")
    request.cwd.mkdir(parents=True)

    job = manager.start(request, runtime_dir=tmp_path / "runtime")
    await provider.wait_for_active_turn(job.job_id, timeout=2)

    assert manager.steer(job.job_id, "focus on the failing tests") is True
    assert manager.cancel(job.job_id) is True
    result = await manager.wait(job.job_id)

    assert result is not None
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    steer_call = next(call for call in calls if call["method"] == "turn/steer")
    assert steer_call["params"]["input"] == [{"type": "text", "text": "focus on the failing tests"}]
    assert steer_call["params"]["expectedTurnId"].startswith("turn-")
