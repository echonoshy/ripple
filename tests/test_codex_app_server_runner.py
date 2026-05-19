import json
import sys
from pathlib import Path

import pytest

from ripple.agent_runners.codex_app_server import CodexAppServerAgentProvider
from ripple.agent_runners.manager import ExternalAgentManager, build_external_agent_manager_from_config
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerStatus
from ripple.sandbox.config import SandboxConfig


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
        f.write(json.dumps({
            "pid": os.getpid(),
            "codex_home": os.environ.get("CODEX_HOME"),
            "home": os.environ.get("HOME"),
            "path": os.environ.get("PATH"),
            "xdg_config_home": os.environ.get("XDG_CONFIG_HOME"),
            "tmpdir": os.environ.get("TMPDIR"),
            "notion_api_token": os.environ.get("NOTION_API_TOKEN"),
            "gog_keyring_password": os.environ.get("GOG_KEYRING_PASSWORD"),
            **payload,
        }) + "\\n")


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
        permission_profile = params.get("config", {}).get("permissions", {}).get("ripple_workspace", {})
        filesystem = permission_profile.get("filesystem", {})
        if params.get("permissions") != {"type": "profile", "id": "ripple_workspace"}:
            emit({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {
                    "code": -32600,
                    "message": "thread/start missing ripple permissions profile",
                },
            })
            continue
        workspace_rule = filesystem.get(params.get("cwd"))
        if filesystem.get(":minimal") != "read" or filesystem.get(":root") is not None or workspace_rule != {
            ".": "write",
            ".git": "write",
            ".agents": "read",
            ".codex": "read",
        }:
            emit({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {
                    "code": -32600,
                    "message": "thread/start missing filesystem profile roots",
                },
            })
            continue
        thread_counter += 1
        thread_id = f"thr-{thread_counter}"
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"thread": {"id": thread_id}}})
        emit({"jsonrpc": "2.0", "method": "thread/started", "params": {"thread": {"id": thread_id}}})
    elif method == "thread/resume":
        permission_profile = params.get("config", {}).get("permissions", {}).get("ripple_workspace", {})
        filesystem = permission_profile.get("filesystem", {})
        if params.get("permissions") != {"type": "profile", "id": "ripple_workspace"}:
            emit({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {
                    "code": -32600,
                    "message": "thread/resume missing ripple permissions profile",
                },
            })
            continue
        workspace_rule = filesystem.get(params.get("cwd"))
        if filesystem.get(":minimal") != "read" or filesystem.get(":root") is not None or workspace_rule != {
            ".": "write",
            ".git": "write",
            ".agents": "read",
            ".codex": "read",
        }:
            emit({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {
                    "code": -32600,
                    "message": "thread/resume missing filesystem profile roots",
                },
            })
            continue
        thread_id = params["threadId"]
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"thread": {"id": thread_id}}})
        emit({"jsonrpc": "2.0", "method": "thread/resumed", "params": {"thread": {"id": thread_id}}})
    elif method == "turn/start":
        if "sandboxPolicy" in params:
            emit({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {
                    "code": -32600,
                    "message": "turn/start must use thread permission profile, not sandboxPolicy",
                },
            })
            continue
        turn_counter += 1
        thread_id = params["threadId"]
        turn_id = f"turn-{turn_counter}"
        text_items = [item.get("text", "") for item in params["input"] if item.get("type") == "text"]
        text = text_items[-1] if text_items else ""
        turns[turn_id] = thread_id
        emit({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {"turn": {"id": turn_id, "status": "inProgress", "items": [], "error": None}},
        })
        if "phase-test" in text:
            emit({
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "agentMessage", "id": "msg-commentary", "text": "", "phase": "commentary"},
                },
            })
            emit({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"threadId": thread_id, "turnId": turn_id, "itemId": "msg-commentary", "delta": "working"},
            })
            emit({
                "jsonrpc": "2.0",
                "method": "item/completed",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "agentMessage", "id": "msg-commentary", "text": "working", "phase": "commentary"},
                },
            })
            emit({
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "agentMessage", "id": "msg-final", "text": "", "phase": "final_answer"},
                },
            })
            emit({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"threadId": thread_id, "turnId": turn_id, "itemId": "msg-final", "delta": "final"},
            })
            emit({
                "jsonrpc": "2.0",
                "method": "item/completed",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "agentMessage", "id": "msg-final", "text": "final", "phase": "final_answer"},
                },
            })
        else:
            emit({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"threadId": thread_id, "turnId": turn_id, "delta": f"reply:{text}"},
            })
        if "fail-turn" in text:
            emit({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "turn": {
                        "id": turn_id,
                        "status": "failed",
                        "error": {"message": "structured output schema rejected"},
                    },
                },
            })
        elif "sleep" not in text:
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
        text_items = [item.get("text", "") for item in params["input"] if item.get("type") == "text"]
        text = text_items[-1] if text_items else ""
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"turnId": turn_id}})
        emit({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "delta": f"steered:{text}"},
        })
""",
        encoding="utf-8",
    )


def _write_fake_approval_app_server(path: Path) -> None:
    path.write_text(
        """
import json
import os
import sys

log_file = os.environ["FAKE_APP_SERVER_LOG"]
process_file = os.environ["FAKE_APP_SERVER_PROCESSES"]


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()


def record(payload):
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "pid": os.getpid(),
            "codex_home": os.environ.get("CODEX_HOME"),
            "home": os.environ.get("HOME"),
            "path": os.environ.get("PATH"),
            "xdg_config_home": os.environ.get("XDG_CONFIG_HOME"),
            "notion_api_token": os.environ.get("NOTION_API_TOKEN"),
            "gog_keyring_password": os.environ.get("GOG_KEYRING_PASSWORD"),
            **payload,
        }) + "\\n")


with open(process_file, "a", encoding="utf-8") as f:
    f.write(str(os.getpid()) + "\\n")

thread_id = "thr-approval"
turn_id = "turn-approval"

for raw_line in sys.stdin:
    message = json.loads(raw_line)
    method = message.get("method")
    params = message.get("params", {})
    record({"method": method, "params": params, "id": message.get("id"), "result": message.get("result")})

    if method == "initialize":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "fake-codex"}}})
    elif method == "initialized":
        pass
    elif method == "thread/start":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"thread": {"id": thread_id}}})
    elif method == "turn/start":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
        emit({
            "jsonrpc": "2.0",
            "id": "approval-1",
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": "item-approval",
                "command": "rm -rf build",
                "cwd": "/workspace",
                "reason": "needs confirmation"
            }
        })
    elif message.get("id") == "approval-1":
        emit({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "delta": f"approval:{message.get('result')}"},
        })
        emit({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}},
        })
""",
        encoding="utf-8",
    )


def _write_fake_unsupported_request_app_server(path: Path) -> None:
    path.write_text(
        """
import json
import os
import sys

log_file = os.environ["FAKE_APP_SERVER_LOG"]
process_file = os.environ["FAKE_APP_SERVER_PROCESSES"]
thread_id = "thr-unsupported"
turn_id = "turn-unsupported"


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()


def record(payload):
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "pid": os.getpid(),
            "method": payload.get("method"),
            "params": payload.get("params"),
            "id": payload.get("id"),
            "result": payload.get("result"),
            "error": payload.get("error"),
        }) + "\\n")


with open(process_file, "a", encoding="utf-8") as f:
    f.write(str(os.getpid()) + "\\n")

for raw_line in sys.stdin:
    message = json.loads(raw_line)
    method = message.get("method")
    params = message.get("params", {})
    record({
        "method": method,
        "params": params,
        "id": message.get("id"),
        "result": message.get("result"),
        "error": message.get("error"),
    })

    if method == "initialize":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "fake-codex"}}})
    elif method == "initialized":
        pass
    elif method == "thread/start":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"thread": {"id": thread_id}}})
    elif method == "turn/start":
        emit({"jsonrpc": "2.0", "id": message["id"], "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
        emit({
            "jsonrpc": "2.0",
            "id": "unsupported-1",
            "method": "item/tool/requestUserInput",
            "params": {"threadId": thread_id, "turnId": turn_id, "itemId": "ask-1"},
        })
    elif message.get("id") == "unsupported-1":
        emit({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "delta": "declined unsupported request"},
        })
        emit({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turnId": turn_id, "turn": {"id": turn_id, "status": "completed"}},
        })
""",
        encoding="utf-8",
    )


def _write_fake_silent_app_server(path: Path) -> None:
    path.write_text(
        """
import json
import os
import sys

log_file = os.environ["FAKE_APP_SERVER_LOG"]
process_file = os.environ["FAKE_APP_SERVER_PROCESSES"]

with open(process_file, "a", encoding="utf-8") as f:
    f.write(str(os.getpid()) + "\\n")

for raw_line in sys.stdin:
    message = json.loads(raw_line)
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps({"method": message.get("method"), "id": message.get("id")}) + "\\n")
    sys.stdout.flush()
""",
        encoding="utf-8",
    )


def _provider(tmp_path: Path) -> CodexAppServerAgentProvider:
    script = tmp_path / "fake_app_server.py"
    _write_fake_app_server(script)
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    return CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(script)],
        codex_home=codex_home,
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


def test_app_server_provider_rejects_danger_full_access_by_default(tmp_path):
    with pytest.raises(ValueError, match="danger-full-access is unsafe"):
        CodexAppServerAgentProvider(
            codex_executable=sys.executable,
            app_server_args=[str(tmp_path / "fake_app_server.py")],
            sandbox_type="danger-full-access",
        )


def test_build_external_agent_manager_resolves_relative_codex_home(tmp_path, monkeypatch):
    config_path = tmp_path / "config" / "settings.yaml"
    config_path.parent.mkdir()
    config_path.write_text("", encoding="utf-8")

    class FakeConfig:
        def get(self, key: str, default=None):
            values = {
                "external_agents.codex": {
                    "enabled": True,
                    "codex_executable": sys.executable,
                    "app_server_args": [str(tmp_path / "fake_app_server.py")],
                    "codex_home": ".ripple/codex-service-home",
                    "sandbox_type": "workspace-write",
                }
            }
            return values.get(key, default)

    fake_config = FakeConfig()
    fake_config.config_path = config_path
    monkeypatch.setattr("ripple.utils.config.get_config", lambda: fake_config)

    manager = build_external_agent_manager_from_config()
    provider = manager.providers["codex"]

    assert provider.pool.codex_home == tmp_path / ".ripple" / "codex-service-home"


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
    assert {call["codex_home"] for call in calls} == {str(tmp_path / "codex-home")}
    thread_start = calls[2]["params"]
    assert thread_start["cwd"] == str(request.cwd)
    assert "sandbox" not in thread_start
    assert thread_start["permissions"] == {"type": "profile", "id": "ripple_workspace"}
    assert thread_start["ephemeral"] is True
    config = thread_start["config"]
    assert config["default_permissions"] == "ripple_workspace"
    assert config["shell_environment_policy"]["exclude"] == ["CODEX_HOME"]
    profile = config["permissions"]["ripple_workspace"]
    assert profile["network"] == {"enabled": True}
    assert profile["filesystem"][":minimal"] == "read"
    assert ":root" not in profile["filesystem"]
    assert ":project_roots" not in profile["filesystem"]
    assert profile["filesystem"][str(request.cwd.resolve())] == {
        ".": "write",
        ".git": "write",
        ".agents": "read",
        ".codex": "read",
    }
    assert profile["filesystem"][str(tmp_path / "codex-home")] == "none"
    turn_start = calls[3]["params"]
    assert turn_start["cwd"] == str(request.cwd)
    assert turn_start["approvalPolicy"] == "never"
    assert "sandboxPolicy" not in turn_start

    events = _read_jsonl(result.events_file)
    assert "runner.started" in [event["type"] for event in events]
    assert "codex.notification" in [event["type"] for event in events]
    assert "runner.completed" in [event["type"] for event in events]
    assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))


@pytest.mark.asyncio
async def test_app_server_provider_marks_failed_turn_as_failed(tmp_path):
    provider = _provider(tmp_path)
    request = _request(tmp_path, prompt="fail-turn")
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.FAILED
    assert result.error is not None
    assert "structured output schema rejected" in result.error
    assert "runner.failed" in [event["type"] for event in _read_jsonl(result.events_file)]


@pytest.mark.asyncio
async def test_app_server_provider_fails_when_json_rpc_request_times_out(tmp_path):
    script = tmp_path / "fake_silent_app_server.py"
    _write_fake_silent_app_server(script)
    provider = CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(script)],
        env={
            "FAKE_APP_SERVER_LOG": str(tmp_path / "app-server.jsonl"),
            "FAKE_APP_SERVER_PROCESSES": str(tmp_path / "processes.txt"),
        },
        request_timeout_seconds=0.1,
    )
    request = _request(tmp_path, prompt="inspect project")
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.FAILED
    assert result.error is not None
    assert "timed out waiting for Codex app-server response to initialize" in result.error
    assert "runner.failed" in [event["type"] for event in _read_jsonl(result.events_file)]
    assert "user-a" not in provider.pool.sessions


@pytest.mark.asyncio
async def test_app_server_provider_output_uses_final_answer_without_commentary_or_duplicates(tmp_path):
    provider = _provider(tmp_path)
    request = _request(tmp_path, prompt="phase-test")
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    assert result.output_file is not None
    assert result.output_file.read_text(encoding="utf-8") == "final"


@pytest.mark.asyncio
async def test_app_server_provider_forwards_multimodal_input_items(tmp_path):
    provider = _provider(tmp_path)
    image_path = tmp_path / "diagram.png"
    image_path.write_bytes(b"fake-png")
    request = _request(tmp_path, prompt="inspect image").model_copy(
        update={
            "input_items": [
                {"type": "localImage", "path": str(image_path)},
                {"type": "text", "text": "inspect image"},
            ]
        }
    )
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert turn_start["params"]["input"] == [
        {"type": "localImage", "path": str(image_path)},
        {"type": "text", "text": "inspect image"},
    ]


@pytest.mark.asyncio
async def test_app_server_provider_forwards_turn_configuration(tmp_path):
    provider = _provider(tmp_path)
    request = AgentRunnerRequest(
        provider="codex",
        prompt="inspect project",
        cwd=tmp_path / "workspace",
        max_runtime_seconds=5,
        user_id="user-a",
        session_id="session-test",
        model="gpt-5.5",
        effort="high",
        summary="detailed",
        output_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
    )
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert turn_start["params"]["model"] == "gpt-5.5"
    assert turn_start["params"]["effort"] == "high"
    assert turn_start["params"]["summary"] == "detailed"
    assert turn_start["params"]["outputSchema"] == {"type": "object", "properties": {"ok": {"type": "boolean"}}}


@pytest.mark.asyncio
async def test_app_server_provider_starts_persistent_thread_and_reuses_loaded_thread(tmp_path):
    provider = _provider(tmp_path)
    first = _request(tmp_path, prompt="first persistent turn").model_copy(
        update={"metadata": {"codex_persistent_thread": True}}
    )
    first.cwd.mkdir(parents=True)

    first_result = await provider.run(first, job_dir=tmp_path / "job-1")

    assert first_result.status == AgentRunnerStatus.COMPLETED
    assert first_result.metadata["codex_thread_id"] == "thr-1"
    assert first_result.metadata["codex_thread_resumed"] is False

    second = _request(tmp_path, prompt="second persistent turn").model_copy(
        update={"metadata": {"codex_persistent_thread": True, "codex_thread_id": "thr-1"}}
    )
    second.cwd.mkdir(parents=True, exist_ok=True)

    second_result = await provider.run(second, job_dir=tmp_path / "job-2")

    assert second_result.status == AgentRunnerStatus.COMPLETED
    assert second_result.metadata["codex_thread_id"] == "thr-1"
    assert second_result.metadata["codex_thread_resumed"] is False
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    assert [call["method"] for call in calls] == [
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "turn/start",
    ]
    thread_start = next(call for call in calls if call["method"] == "thread/start")
    assert thread_start["params"]["ephemeral"] is False
    turn_starts = [call for call in calls if call["method"] == "turn/start"]
    assert [call["params"]["threadId"] for call in turn_starts] == ["thr-1", "thr-1"]


@pytest.mark.asyncio
async def test_app_server_provider_resumes_persistent_thread_after_process_restart(tmp_path):
    provider = _provider(tmp_path)
    first = _request(tmp_path, prompt="first persistent turn").model_copy(
        update={"metadata": {"codex_persistent_thread": True}}
    )
    first.cwd.mkdir(parents=True)
    first_result = await provider.run(first, job_dir=tmp_path / "job-1")
    assert first_result.metadata["codex_thread_id"] == "thr-1"

    await provider.stop_user("user-a")

    second = _request(tmp_path, prompt="second persistent turn").model_copy(
        update={"metadata": {"codex_persistent_thread": True, "codex_thread_id": "thr-1"}}
    )
    second.cwd.mkdir(parents=True, exist_ok=True)

    second_result = await provider.run(second, job_dir=tmp_path / "job-2")

    assert second_result.status == AgentRunnerStatus.COMPLETED
    assert second_result.metadata["codex_thread_id"] == "thr-1"
    assert second_result.metadata["codex_thread_resumed"] is True
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    assert [call["method"] for call in calls] == [
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "initialize",
        "initialized",
        "thread/resume",
        "turn/start",
    ]
    thread_resume = next(call for call in calls if call["method"] == "thread/resume")
    assert thread_resume["params"]["threadId"] == "thr-1"
    assert thread_resume["params"]["cwd"] == str(second.cwd)
    assert thread_resume["params"]["permissions"] == {"type": "profile", "id": "ripple_workspace"}


@pytest.mark.asyncio
async def test_app_server_provider_declines_unsupported_server_request(tmp_path):
    script = tmp_path / "fake_unsupported_request_app_server.py"
    _write_fake_unsupported_request_app_server(script)
    provider = CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(script)],
        env={
            "FAKE_APP_SERVER_LOG": str(tmp_path / "app-server.jsonl"),
            "FAKE_APP_SERVER_PROCESSES": str(tmp_path / "processes.txt"),
        },
        idle_timeout_seconds=60,
    )
    request = _request(tmp_path, prompt="trigger unsupported").model_copy(update={"max_runtime_seconds": 1})
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    assert result.output_file is not None
    assert "declined unsupported request" in result.output_file.read_text(encoding="utf-8")
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    unsupported_response = next(call for call in calls if call["id"] == "unsupported-1" and call["error"] is not None)
    assert unsupported_response["error"]["code"] == -32601
    assert "unsupported" in unsupported_response["error"]["message"].lower()
    events = _read_jsonl(result.events_file)
    assert "codex.server_request_unsupported" in [event["type"] for event in events]


@pytest.mark.asyncio
async def test_app_server_provider_uses_host_cwd_even_when_sandbox_cwd_is_present(tmp_path):
    provider = _provider(tmp_path)
    request = _request(tmp_path, prompt="inspect nested project")
    request.cwd.mkdir(parents=True)
    request = request.model_copy(update={"metadata": {"sandbox_cwd": "/workspace/nested"}})

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    thread_start = next(call for call in calls if call["method"] == "thread/start")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert thread_start["params"]["cwd"] == str(request.cwd)
    assert turn_start["params"]["cwd"] == str(request.cwd)
    filesystem = thread_start["params"]["config"]["permissions"]["ripple_workspace"]["filesystem"]
    assert filesystem[":minimal"] == "read"
    assert ":root" not in filesystem
    assert ":project_roots" not in filesystem
    assert filesystem[str(request.cwd.resolve())] == {
        ".": "write",
        ".git": "write",
        ".agents": "read",
        ".codex": "read",
    }
    assert "sandboxPolicy" not in turn_start["params"]


@pytest.mark.asyncio
async def test_app_server_provider_normalizes_legacy_workspace_write_sandbox_type(tmp_path):
    provider = CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(tmp_path / "fake_app_server.py")],
        sandbox_type="workspaceWrite",
        env={
            "FAKE_APP_SERVER_LOG": str(tmp_path / "app-server.jsonl"),
            "FAKE_APP_SERVER_PROCESSES": str(tmp_path / "processes.txt"),
        },
    )
    _write_fake_app_server(tmp_path / "fake_app_server.py")
    request = _request(tmp_path, prompt="inspect project")
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    thread_start = next(call for call in calls if call["method"] == "thread/start")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert thread_start["params"]["permissions"] == {"type": "profile", "id": "ripple_workspace"}
    assert "sandboxPolicy" not in turn_start["params"]


@pytest.mark.asyncio
async def test_app_server_provider_does_not_wrap_process_with_nsjail_by_default(tmp_path, monkeypatch):
    script = tmp_path / "fake_app_server.py"
    _write_fake_app_server(script)

    def fake_build_nsjail_argv(config, user_id, command):
        raise AssertionError("trusted Codex app-server must not run inside the user nsjail by default")

    monkeypatch.setattr("ripple.sandbox.nsjail_config.build_nsjail_argv", fake_build_nsjail_argv)
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    provider = CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(script)],
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
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert turn_start["params"]["cwd"] == str(request.cwd)


@pytest.mark.asyncio
async def test_app_server_permission_profile_denies_sibling_user_sandboxes(tmp_path):
    provider = _provider(tmp_path)
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    request = _request(tmp_path, prompt="inspect sandboxed project")
    request = request.model_copy(
        update={
            "cwd": sandbox_config.workspace_dir("user-a"),
            "metadata": {"sandbox_config": sandbox_config, "sandbox_cwd": "/workspace"},
        }
    )
    request.cwd.mkdir(parents=True)

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    thread_start = next(call for call in calls if call["method"] == "thread/start")
    filesystem = thread_start["params"]["config"]["permissions"]["ripple_workspace"]["filesystem"]
    assert filesystem[str(sandbox_config.sandboxes_root.resolve())] == "none"
    assert filesystem[str(request.cwd.resolve())] == {
        ".": "write",
        ".git": "write",
        ".agents": "read",
        ".codex": "read",
    }
    assert ":root" not in filesystem


@pytest.mark.asyncio
async def test_app_server_provider_starts_trusted_process_with_user_workspace_environment(tmp_path):
    provider = _provider(tmp_path)
    sandbox_config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        uv_bin_dir=str(tmp_path / "uv-bin"),
        node_dir=str(tmp_path / "node"),
        lark_cli_install_root=str(tmp_path / "vendor" / "lark-cli"),
        notion_cli_install_root=str(tmp_path / "vendor" / "notion-cli"),
        gogcli_cli_install_root=str(tmp_path / "vendor" / "gogcli-cli"),
    )
    for root in (
        tmp_path / "vendor" / "lark-cli",
        tmp_path / "vendor" / "notion-cli",
        tmp_path / "vendor" / "gogcli-cli",
    ):
        (root / "current" / "bin").mkdir(parents=True)
    request = _request(tmp_path, prompt="inspect connector env")
    request.cwd.mkdir(parents=True)
    notion_file = sandbox_config.notion_config_file("user-a")
    notion_file.parent.mkdir(parents=True, exist_ok=True)
    notion_file.write_text(json.dumps({"api_token": "ntn_user_token"}), encoding="utf-8")
    gog_pass_file = sandbox_config.gogcli_keyring_pass_file("user-a")
    gog_pass_file.parent.mkdir(parents=True, exist_ok=True)
    gog_pass_file.write_text("gog-pass", encoding="utf-8")
    request = request.model_copy(update={"metadata": {"sandbox_config": sandbox_config, "sandbox_cwd": "/workspace"}})

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    initialize = next(call for call in calls if call["method"] == "initialize")
    assert initialize["home"] == str(request.cwd)
    assert initialize["xdg_config_home"] == str(request.cwd / ".config")
    assert initialize["tmpdir"] == str(request.cwd / ".tmp")
    assert initialize["notion_api_token"] == "ntn_user_token"
    assert initialize["gog_keyring_password"] == "gog-pass"
    assert f"{tmp_path}/vendor/gogcli-cli/current/bin" in initialize["path"]
    assert "/opt/gogcli-cli/current/bin" not in initialize["path"]
    thread_start = next(call for call in calls if call["method"] == "thread/start")
    filesystem = thread_start["params"]["config"]["permissions"]["ripple_workspace"]["filesystem"]
    assert filesystem[str((tmp_path / "uv-bin").resolve())] == "read"
    assert filesystem[str((tmp_path / "node").resolve())] == "read"
    assert filesystem[str((tmp_path / "vendor" / "lark-cli").resolve())] == "read"
    assert filesystem[str((tmp_path / "vendor" / "notion-cli").resolve())] == "read"
    assert filesystem[str((tmp_path / "vendor" / "gogcli-cli").resolve())] == "read"
    assert filesystem[str(sandbox_config.uv_cache_dir.resolve())] == "write"
    assert filesystem[str(sandbox_config.corepack_cache_dir.resolve())] == "write"
    assert filesystem[str(sandbox_config.pnpm_cache_dir.resolve())] == "write"


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
    assert "user-a" not in provider.pool.sessions


@pytest.mark.asyncio
async def test_same_user_runs_can_have_active_turns_concurrently(tmp_path):
    provider = _provider(tmp_path)
    manager = ExternalAgentManager(providers={"codex": provider})
    first = _request(tmp_path, prompt="sleep first turn")
    second = _request(tmp_path, prompt="sleep second turn")
    first.cwd.mkdir(parents=True)
    second.cwd.mkdir(parents=True, exist_ok=True)

    first_job = manager.start(first, runtime_dir=tmp_path / "runtime")
    await provider.wait_for_active_turn(first_job.job_id, timeout=2)

    second_job = manager.start(second, runtime_dir=tmp_path / "runtime")
    second_active = await provider.wait_for_active_turn(second_job.job_id, timeout=0.5)

    assert second_active.turn_id.startswith("turn-")

    assert manager.cancel(first_job.job_id) is True
    assert manager.cancel(second_job.job_id) is True
    first_result = await manager.wait(first_job.job_id)
    second_result = await manager.wait(second_job.job_id)

    assert first_result is not None
    assert second_result is not None
    assert first_result.status == AgentRunnerStatus.CANCELLED
    assert second_result.status == AgentRunnerStatus.CANCELLED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    assert [call["method"] for call in calls].count("turn/start") == 2


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


@pytest.mark.asyncio
async def test_manager_resolves_codex_command_approval(tmp_path):
    script = tmp_path / "fake_approval_app_server.py"
    _write_fake_approval_app_server(script)
    provider = CodexAppServerAgentProvider(
        codex_executable=sys.executable,
        app_server_args=[str(script)],
        env={
            "FAKE_APP_SERVER_LOG": str(tmp_path / "app-server.jsonl"),
            "FAKE_APP_SERVER_PROCESSES": str(tmp_path / "processes.txt"),
        },
        idle_timeout_seconds=60,
    )
    manager = ExternalAgentManager(providers={"codex": provider})
    request = _request(tmp_path, prompt="needs approval")
    request.cwd.mkdir(parents=True)

    job = manager.start(request, runtime_dir=tmp_path / "runtime")
    pending = await manager.wait_for_pending_approval(job.job_id, timeout=2)

    assert pending["source"] == "codex"
    assert pending["request_id"] == "approval-1"
    assert pending["description"] == "rm -rf build"
    assert manager.resolve_approval(job.job_id, "approval-1", "allow") is True

    result = await manager.wait(job.job_id)

    assert result is not None
    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    approval_response = next(call for call in calls if call["id"] == "approval-1" and call["result"] is not None)
    assert approval_response["result"] == {"decision": "accept"}
