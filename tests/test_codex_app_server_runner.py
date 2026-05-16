import json
import sys
from pathlib import Path

import pytest

from ripple.agent_runners.codex_app_server import CodexAppServerAgentProvider
from ripple.agent_runners.manager import ExternalAgentManager
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
        project_roots = filesystem.get(":project_roots")
        if filesystem.get(":root") != "read" or project_roots != {
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
    assert profile["filesystem"][":root"] == "read"
    assert profile["filesystem"][":project_roots"] == {
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
    assert thread_start["params"]["config"]["permissions"]["ripple_workspace"]["filesystem"][":project_roots"] == {
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
    assert initialize["notion_api_token"] == "ntn_user_token"
    assert initialize["gog_keyring_password"] == "gog-pass"
    assert f"{tmp_path}/vendor/gogcli-cli/current/bin" in initialize["path"]
    assert "/opt/gogcli-cli/current/bin" not in initialize["path"]


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
