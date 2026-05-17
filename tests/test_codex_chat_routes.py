import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server import sessions as session_module
from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerEvent, AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.utils.config import get_config


class InstantCodexProvider:
    def __init__(self, output: str = "codex completed the task"):
        self.output = output
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        events_file.write_text(
            json.dumps(
                AgentRunnerEvent(
                    type="codex.notification",
                    job_id=request.job_id or "job-test",
                    provider=request.provider,
                    data={
                        "message": {
                            "method": "item/agentMessage/delta",
                            "params": {"delta": self.output},
                        }
                    },
                ).model_dump(mode="json"),
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        output_file.write_text(self.output, encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail=self.output,
        )


class CodexToolEventProvider:
    def __init__(self):
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        events = [
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/started",
                        "params": {
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "item": {
                                "type": "commandExecution",
                                "id": "cmd-1",
                                "command": "pwd",
                                "cwd": "/workspace",
                                "processId": None,
                                "source": "agent",
                                "status": "inProgress",
                                "commandActions": [],
                                "aggregatedOutput": None,
                                "exitCode": None,
                                "durationMs": None,
                            },
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "item": {
                                "type": "commandExecution",
                                "id": "cmd-1",
                                "command": "pwd",
                                "cwd": "/workspace",
                                "processId": "proc-1",
                                "source": "agent",
                                "status": "completed",
                                "commandActions": [],
                                "aggregatedOutput": "/workspace\n",
                                "exitCode": 0,
                                "durationMs": 12,
                            },
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/agentMessage/delta",
                        "params": {"delta": "done"},
                    }
                },
            ),
        ]
        events_file.write_text(
            "".join(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n" for event in events),
            encoding="utf-8",
        )
        output_file.write_text("done", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail="done",
        )


class CodexPhasedMessageProvider:
    def __init__(self):
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        events = [
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/started",
                        "params": {
                            "item": {
                                "type": "agentMessage",
                                "id": "msg-commentary",
                                "text": "",
                                "phase": "commentary",
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/agentMessage/delta",
                        "params": {"itemId": "msg-commentary", "delta": "working"},
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "item": {
                                "type": "agentMessage",
                                "id": "msg-commentary",
                                "text": "working",
                                "phase": "commentary",
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/started",
                        "params": {
                            "item": {
                                "type": "agentMessage",
                                "id": "msg-final",
                                "text": "",
                                "phase": "final_answer",
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/agentMessage/delta",
                        "params": {"itemId": "msg-final", "delta": "final"},
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "item": {
                                "type": "agentMessage",
                                "id": "msg-final",
                                "text": "final",
                                "phase": "final_answer",
                            }
                        },
                    }
                },
            ),
        ]
        events_file.write_text(
            "".join(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n" for event in events),
            encoding="utf-8",
        )
        output_file.write_text("final", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail="final",
        )


class CodexUsageEventProvider:
    def __init__(self):
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        events = [
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "thread/tokenUsage/updated",
                        "params": {
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "tokenUsage": {
                                "total": {
                                    "totalTokens": 180,
                                    "inputTokens": 120,
                                    "cachedInputTokens": 10,
                                    "outputTokens": 30,
                                    "reasoningOutputTokens": 30,
                                },
                                "last": {
                                    "totalTokens": 180,
                                    "inputTokens": 120,
                                    "cachedInputTokens": 10,
                                    "outputTokens": 30,
                                    "reasoningOutputTokens": 30,
                                },
                                "modelContextWindow": 200000,
                            },
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/agentMessage/delta",
                        "params": {"delta": "done"},
                    }
                },
            ),
        ]
        events_file.write_text(
            "".join(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n" for event in events),
            encoding="utf-8",
        )
        output_file.write_text("done", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail="done",
        )


class CodexImageEventProvider:
    def __init__(self):
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        generated = job_dir / "generated.png"
        generated.write_bytes(b"png")
        events = [
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "item": {
                                "type": "imageView",
                                "id": "view-1",
                                "path": str(request.cwd / "diagram.png"),
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "item": {
                                "type": "imageGeneration",
                                "id": "ig-1",
                                "status": "completed",
                                "result": "cG5n",
                                "revisedPrompt": "draw a diagram",
                                "savedPath": str(generated),
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={"message": {"method": "item/agentMessage/delta", "params": {"delta": "done"}}},
            ),
        ]
        events_file.write_text(
            "".join(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n" for event in events),
            encoding="utf-8",
        )
        output_file.write_text("done", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail="done",
        )


def _client(tmp_path: Path, monkeypatch, provider: Any) -> TestClient:
    sandbox_config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(sandbox_config)
    session_manager = SessionManager(sandbox_manager=sandbox_manager)
    agent_manager = ExternalAgentManager(providers={"codex": provider})

    monkeypatch.setattr("interfaces.server.routes.get_external_agent_manager", lambda: agent_manager)

    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    set_session_manager(session_manager)
    return TestClient(app, headers={"X-Ripple-User-Id": "alice"})


def test_chat_completions_non_stream_uses_codex_runner_and_persists_messages(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="codex wrote the answer")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {"role": "system", "content": "Always answer tersely."},
                {"role": "user", "content": "Build the thing"},
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "codex wrote the answer"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["session_id"].startswith("srv-")
    assert provider.requests
    assert provider.requests[0].provider == "codex"
    assert provider.requests[0].metadata["sandbox_cwd"] == "/workspace"
    assert "Always answer tersely." in provider.requests[0].prompt
    assert "Build the thing" in provider.requests[0].prompt

    session = client.get(f"/v1/sessions/{body['session_id']}")
    assert session.status_code == 200
    messages = session.json()["messages"]
    assert [message["type"] for message in messages] == ["user", "assistant"]
    assert messages[1]["message"]["content"][0]["text"] == "codex wrote the answer"


def test_chat_completions_codex_mode_does_not_require_legacy_llm_client(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="codex works without legacy client")
    client = _client(tmp_path, monkeypatch, provider)
    assert not hasattr(session_module, "create_client")

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "Use Codex only"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "codex works without legacy client"
    assert provider.requests


def test_chat_completions_ignores_legacy_execution_mode_config(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="codex remains the only chat path")
    client = _client(tmp_path, monkeypatch, provider)
    config = get_config()
    server_config = config._data.setdefault("server", {})
    previous_mode = server_config.get("execution_mode")
    server_config["execution_mode"] = "ripple_legacy"

    try:
        response = client.post(
            "/v1/chat/completions",
            json={
                "model": "codex-medium",
                "stream": False,
                "messages": [{"role": "user", "content": "Do not fall back"}],
            },
        )
    finally:
        if previous_mode is None:
            server_config.pop("execution_mode", None)
        else:
            server_config["execution_mode"] = previous_mode

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "codex remains the only chat path"
    assert provider.requests


def test_create_session_does_not_require_legacy_llm_client(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider()
    client = _client(tmp_path, monkeypatch, provider)
    assert not hasattr(session_module, "create_client")

    response = client.post("/v1/sessions", json={"model": "codex-medium"})

    assert response.status_code == 200
    assert response.json()["session_id"].startswith("srv-")


def test_chat_completions_stream_bridges_codex_output_to_sse(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="codex streamed the answer")
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Stream this"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert response.headers["X-Ripple-Session-Id"].startswith("srv-")
    assert "codex streamed the answer" in body
    assert '"finish_reason": "stop"' in body
    assert "data: [DONE]" in body
    assert provider.requests


def test_chat_completions_stream_bridges_codex_tool_items_to_sse(tmp_path: Path, monkeypatch):
    provider = CodexToolEventProvider()
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Run pwd"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "tool_call"' in body
    assert '"id": "cmd-1"' in body
    assert '"name": "command_execution"' in body
    assert '"command": "pwd"' in body
    assert '"type": "tool_result"' in body
    assert '"tool_use_id": "cmd-1"' in body
    assert "/workspace" in body


def test_chat_completions_stream_keeps_commentary_out_of_final_content(tmp_path: Path, monkeypatch):
    provider = CodexPhasedMessageProvider()
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Stream phased messages"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "assistant_update_delta"' in body
    assert '"delta": "working"' in body
    assert '"content": "final"' in body
    assert '"content": "working"' not in body
    assert '"content": "workingfinal"' not in body


def test_chat_completions_stream_bridges_codex_token_usage_to_sse(tmp_path: Path, monkeypatch):
    provider = CodexUsageEventProvider()
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Hello"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "usage"' in body
    assert '"prompt_tokens": 120' in body
    assert '"completion_tokens": 30' in body
    assert '"total_tokens": 180' in body
    assert '"last_prompt_tokens": 180' in body


def test_chat_completions_preserves_remote_image_content_blocks_for_codex(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="looked at image")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What is in this image?"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/cat.png"}},
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    request = provider.requests[0]
    assert request.input_items[0] == {"type": "image", "url": "https://example.com/cat.png"}
    assert request.input_items[-1]["type"] == "text"
    assert "## Current User Request" in request.input_items[-1]["text"]
    assert "What is in this image?" in request.input_items[-1]["text"]
    assert "What is in this image?" in request.prompt


def test_chat_completions_accepts_image_only_content_blocks(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="looked at image")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "https://example.com/only.png"}},
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    assert provider.requests[0].input_items[0] == {
        "type": "image",
        "url": "https://example.com/only.png",
    }
    assert provider.requests[0].input_items[-1]["type"] == "text"


def test_chat_completions_converts_workspace_image_path_to_local_image(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="looked at local image")
    client = _client(tmp_path, monkeypatch, provider)
    upload = client.post(
        "/v1/workspace/attachments",
        files={"file": ("diagram.png", b"\x89PNG\r\n\x1a\nbytes", "image/png")},
        data={"kind": "image"},
    )
    assert upload.status_code == 200
    image_path = upload.json()["path"]

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Inspect this diagram."},
                        {
                            "type": "file",
                            "file": {
                                "path": image_path,
                                "name": "diagram.png",
                                "mime_type": "image/png",
                            },
                        },
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    local_images = [item for item in provider.requests[0].input_items if item["type"] == "localImage"]
    assert len(local_images) == 1
    assert local_images[0]["path"].endswith("diagram.png")


def test_chat_completions_stream_bridges_codex_image_items_to_sse(tmp_path: Path, monkeypatch):
    provider = CodexImageEventProvider()
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Generate an image"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "image_view"' in body
    assert '"workspace_path": "/workspace/diagram.png"' in body
    assert '"type": "image_generation"' in body
    assert '"workspace_path": "/workspace/.ripple/generated/ig-1.png"' in body
    assert '"savedPath"' not in body
    assert '"saved_path"' not in body
    assert '"result": "cG5n"' not in body

    generated = tmp_path / "sandboxes" / "alice" / "workspace" / ".ripple" / "generated" / "ig-1.png"
    assert generated.read_bytes() == b"png"


def test_chat_completions_persists_user_image_blocks(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="done")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "See image"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
                    ],
                }
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()

    session = client.get(f"/v1/sessions/{body['session_id']}")
    user_message = session.json()["messages"][0]
    assert user_message["message"]["content"] == [
        {"type": "text", "text": "See image"},
        {"type": "image", "url": "https://example.com/a.png"},
    ]
