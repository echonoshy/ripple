import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server import codex_chat
from interfaces.server import sessions as session_module
from interfaces.server.auth import verify_api_key
from interfaces.server.routes import get_session_manager, router, set_session_manager
from interfaces.server.schedule_chat import SCHEDULE_EXTRACTION_OUTPUT_SCHEMA
from interfaces.server.sessions import SessionManager
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerEvent, AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus
from ripple.connectors import registry
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.gogcli_oauth import GoogleOAuthIdentity, GoogleOAuthToken
from ripple.sandbox.manager import SandboxManager
from ripple.schedules import get_schedule
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


class FailingCodexProvider:
    def __init__(self, error: str = "schema rejected"):
        self.error = error
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        events_file.write_text("", encoding="utf-8")
        output_file.write_text("", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.FAILED,
            events_file=events_file,
            output_file=output_file,
            error=self.error,
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
                                    "totalTokens": 90,
                                    "inputTokens": 60,
                                    "cachedInputTokens": 5,
                                    "outputTokens": 20,
                                    "reasoningOutputTokens": 10,
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


class CodexRuntimeEventProvider:
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
                        "method": "turn/diff/updated",
                        "params": {"threadId": "thread-1", "turnId": "turn-1", "diff": {"files": ["app.py"]}},
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/commandExecution/outputDelta",
                        "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "cmd-1", "delta": "pytest"},
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/fileChange/patchUpdated",
                        "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "file-1", "patch": "@@ ..."},
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={"message": {"method": "warning", "params": {"message": "low context"}}},
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={"message": {"method": "error", "params": {"message": "tool failed"}}},
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
                            "item": {"type": "contextCompaction", "id": "compact-1", "status": "completed"},
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


class PersistentThreadProvider(InstantCodexProvider):
    def __init__(self, output: str = "threaded answer", thread_id: str = "thread-1"):
        super().__init__(output=output)
        self.thread_id = thread_id

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        result = await super().run(request, job_dir=job_dir)
        return result.model_copy(update={"metadata": {"codex_thread_id": self.thread_id}})


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
    assert "Do not run or mention `proxy_on`" in provider.requests[0].prompt

    session = client.get(f"/v1/sessions/{body['session_id']}")
    assert session.status_code == 200
    messages = session.json()["messages"]
    assert [message["type"] for message in messages] == ["user", "assistant"]
    assert messages[1]["message"]["content"][0]["text"] == "codex wrote the answer"


def test_chat_completions_forwards_codex_turn_configuration(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="configured")
    client = _client(tmp_path, monkeypatch, provider)
    output_schema = {"type": "object", "properties": {"answer": {"type": "string"}}}

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "effort": "high",
            "summary": "detailed",
            "outputSchema": output_schema,
            "messages": [{"role": "user", "content": "Use the requested turn config"}],
        },
    )

    assert response.status_code == 200
    request = provider.requests[0]
    assert request.model == "gpt-5.5"
    assert request.effort == "high"
    assert request.summary == "detailed"
    assert request.output_schema == output_schema


def test_chat_completions_reuses_codex_thread_without_reinjecting_history(tmp_path: Path, monkeypatch):
    provider = PersistentThreadProvider(output="threaded answer", thread_id="thread-1")
    client = _client(tmp_path, monkeypatch, provider)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "First question only for history"}],
        },
    )

    assert first.status_code == 200
    session_id = first.json()["session_id"]
    assert provider.requests[0].metadata["codex_persistent_thread"] is True
    assert "codex_thread_id" not in provider.requests[0].metadata

    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "Second question"}],
        },
    )

    assert second.status_code == 200
    assert provider.requests[1].metadata["codex_persistent_thread"] is True
    assert provider.requests[1].metadata["codex_thread_id"] == "thread-1"
    assert "Second question" in provider.requests[1].prompt
    assert "First question only for history" not in provider.requests[1].prompt
    assert "threaded answer" not in provider.requests[1].prompt
    assert "## Conversation So Far" not in provider.requests[1].prompt


def test_chat_auth_preflight_captures_notion_token_then_resumes_codex(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="notion task completed")
    client = _client(tmp_path, monkeypatch, provider)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "帮我查一下 Notion 里的项目计划"}],
        },
    )

    assert first.status_code == 200
    first_body = first.json()
    assert first_body["connector_auth"]["connector"] == "notion"
    assert first_body["connector_auth"]["stage"] == "awaiting_token"
    assert "Notion" in first_body["choices"][0]["message"]["content"]
    assert provider.requests == []

    token = "ntn_" + "x" * 40
    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first_body["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": token}],
        },
    )

    assert second.status_code == 200
    second_body = second.json()
    assert second_body["connector_auth"]["connector"] == "notion"
    assert second_body["connector_auth"]["stage"] == "authorized"
    assert token not in second.text
    assert get_session_manager().sandbox_manager.config.has_notion_token("alice") is True
    assert len(provider.requests) == 1
    assert "帮我查一下 Notion 里的项目计划" in provider.requests[0].prompt
    assert token not in provider.requests[0].prompt


def test_chat_auth_preflight_starts_feishu_before_codex(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-123",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "用 feishu cli 给胡畔发一条消息，说 hi"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["connector_auth"]["connector"] == "feishu"
    assert body["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "[FEISHU_AUTH]" in body["choices"][0]["message"]["content"]
    assert provider.requests == []


def test_chat_auth_preflight_starts_google_assisted_oauth_before_codex(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    manager = get_session_manager()
    config = manager.sandbox_manager.config
    config.gogcli_cli_install_root = str(tmp_path / "gogcli")
    client_config = config.gogcli_client_config_file("alice")
    client_config.parent.mkdir(parents=True, exist_ok=True)
    client_config.write_text(
        json.dumps({"web": {"client_id": "client-id", "client_secret": "client-secret"}}),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        registry,
        "resolve_gogcli_oauth_callback_url",
        lambda request_base_url=None: "https://test-oauth.example/v1/sandboxes/gogcli/oauth/callback",
    )

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "查看我的 gmail 邮件"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    content = body["choices"][0]["message"]["content"]
    assert body["connector_auth"]["connector"] == "google_workspace"
    assert body["connector_auth"]["stage"] == "awaiting_browser_callback"
    assert body["connector_auth"]["action"]["data"]["callback_mode"] == "assisted"
    assert "email" not in body["connector_auth"]["action"]["data"]
    assert "[GOOGLE_AUTH]" in content
    assert "https://accounts.google.com/o/oauth2/auth" in content
    assert "client_id=client-id" in content
    assert "select_account" in content
    assert "邮箱地址" not in content
    assert "callback URL" not in content
    assert "好了" not in content
    assert provider.requests == []


def test_google_oauth_callback_imports_selected_account_without_prompt_email(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    config = get_session_manager().sandbox_manager.config
    config.gogcli_cli_install_root = str(tmp_path / "gogcli")
    client_config = config.gogcli_client_config_file("alice")
    client_config.parent.mkdir(parents=True, exist_ok=True)
    client_config.write_text(
        json.dumps({"web": {"client_id": "client-id", "client_secret": "client-secret"}}),
        encoding="utf-8",
    )

    registry.register_pending_gogcli_oauth(
        state="state-selected",
        user_id="alice",
        redirect_uri="https://test-oauth.example/v1/sandboxes/gogcli/oauth/callback",
    )

    async def fake_exchange_google_oauth_code(**kwargs):
        assert kwargs["code"] == "auth-code"
        assert kwargs["redirect_uri"] == "https://test-oauth.example/v1/sandboxes/gogcli/oauth/callback"
        return GoogleOAuthToken(access_token="access-token", refresh_token="refresh-token")

    async def fake_fetch_google_oauth_identity(**kwargs):
        assert kwargs["access_token"] == "access-token"
        return GoogleOAuthIdentity(email="Selected@Example.COM", subject="google-subject")

    imported: dict[str, Any] = {}

    async def fake_execute_in_sandbox(command, config, user_id, timeout=None, stdin=None):
        imported["command"] = command
        imported["user_id"] = user_id
        imported["stdin"] = stdin
        keyring_file = config.workspace_dir(user_id) / ".config" / "gogcli" / "keyring" / "token"
        keyring_file.parent.mkdir(parents=True, exist_ok=True)
        keyring_file.write_text("encrypted-token", encoding="utf-8")
        return "imported\ttrue\n", "", 0

    monkeypatch.setattr(registry, "exchange_google_oauth_code", fake_exchange_google_oauth_code)
    monkeypatch.setattr(registry, "fetch_google_oauth_identity", fake_fetch_google_oauth_identity)
    monkeypatch.setattr(registry, "execute_in_sandbox", fake_execute_in_sandbox)

    response = client.get(
        "/v1/sandboxes/gogcli/oauth/callback?state=state-selected&code=auth-code",
    )

    assert response.status_code == 200
    assert "Google 授权完成" in response.text
    assert imported["command"] == "/opt/gogcli-cli/current/bin/gog auth tokens import -"
    assert "refresh-token" not in imported["command"]
    payload = json.loads(imported["stdin"])
    assert payload["email"] == "selected@example.com"
    assert payload["subject"] == "google-subject"
    assert payload["refresh_token"] == "refresh-token"
    assert payload["services"] == ["gmail", "drive", "calendar", "docs", "sheets", "slides"]


def test_chat_auth_reauth_starts_feishu_even_when_connected(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (True, "Feishu user authorization is ready.", {"has_app_config": True}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        assert force_new_setup is False
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device/reauth",
            "device_code": "device-reauth",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "重新授权飞书，刚才提示 missing_scope"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["connector_auth"]["connector"] == "feishu"
    assert body["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "https://accounts.feishu.cn/device/reauth" in body["choices"][0]["message"]["content"]
    assert provider.requests == []


def test_chat_auth_preflight_streams_feishu_auth_without_starting_codex(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-123",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "用 feishu cli 给胡畔发一条消息，说 hi"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "connector_auth_required"' in body
    assert '"connector": "feishu"' in body
    assert '"stage": "awaiting_user_auth"' in body
    assert "[FEISHU_AUTH]" in body
    assert "https://accounts.feishu.cn/device" in body
    assert provider.requests == []


def test_chat_feishu_setup_done_advances_to_user_auth(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    ensure_calls = 0

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": False}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        nonlocal ensure_calls
        ensure_calls += 1
        if ensure_calls == 1:
            return False, "https://open.feishu.cn/page/cli?user_code=SETUP"
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-456",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "使用飞书给胡畔发 hi"}],
        },
    )

    assert first.status_code == 200
    assert first.json()["connector_auth"]["stage"] == "awaiting_setup"
    assert "[FEISHU_SETUP]" in first.json()["choices"][0]["message"]["content"]

    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "[FEISHU_AUTH]" in second.json()["choices"][0]["message"]["content"]
    assert provider.requests == []


def test_task_feishu_setup_poll_advances_to_user_auth_without_user_done(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    ensure_calls = 0

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": False}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        nonlocal ensure_calls
        ensure_calls += 1
        if ensure_calls == 1:
            return False, "https://open.feishu.cn/page/cli?user_code=SETUP"
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-poll-setup",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "使用飞书给胡畔发 hi"}],
        },
    )
    assert first.status_code == 200
    session_id = first.json()["session_id"]

    second = client.post(
        f"/v1/tasks/{session_id}/connector-auth/poll",
        json={"model": "codex-medium", "stream": False},
    )

    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "[FEISHU_AUTH]" in second.json()["choices"][0]["message"]["content"]
    assert provider.requests == []

    session = client.get(f"/v1/sessions/{session_id}")
    messages = session.json()["messages"]
    assert [message["type"] for message in messages] == ["user", "assistant", "assistant"]
    user_texts = [
        block["text"]
        for message in messages
        if message["type"] == "user"
        for block in message["message"]["content"]
        if block.get("type") == "text"
    ]
    assert user_texts == ["使用飞书给胡畔发 hi"]


def test_chat_feishu_setup_done_requires_real_user_auth_evidence(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    config = get_session_manager().sandbox_manager.config
    config.lark_cli_bin = str(tmp_path / "lark-cli")
    ensure_calls = 0

    class FakeCompletedProcess:
        def __init__(self, stdout: str, returncode: int = 0):
            self.stdout = stdout
            self.stderr = ""
            self.returncode = returncode

    def fake_run(argv, **kwargs):
        command = argv[-1]
        if "doctor" in command:
            return FakeCompletedProcess(
                json.dumps(
                    {
                        "checks": [
                            {"name": "config_file", "status": "pass"},
                            {"name": "app_resolved", "status": "pass"},
                            {"name": "token_exists", "status": "pass"},
                        ]
                    }
                )
            )
        assert "auth status" in command
        return FakeCompletedProcess(json.dumps({"ok": True}))

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        nonlocal ensure_calls
        ensure_calls += 1
        if ensure_calls == 1:
            return False, "https://open.feishu.cn/page/cli?user_code=SETUP"
        cli_config = config.workspace_dir(user_id) / ".lark-cli" / "config.json"
        cli_config.parent.mkdir(parents=True, exist_ok=True)
        cli_config.write_text("{}", encoding="utf-8")
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-after-setup",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "write_nsjail_config", lambda config, user_id: None)
    monkeypatch.setattr(registry, "build_nsjail_argv", lambda config, user_id, command: ["sh", "-c", command])
    monkeypatch.setattr(registry.subprocess, "run", fake_run)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "使用飞书cli给胡畔发 hi"}],
        },
    )

    assert first.status_code == 200
    assert first.json()["connector_auth"]["stage"] == "awaiting_setup"
    assert provider.requests == []

    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "[FEISHU_AUTH]" in second.json()["choices"][0]["message"]["content"]
    assert "https://accounts.feishu.cn/device" in second.json()["choices"][0]["message"]["content"]
    assert provider.requests == []


def test_chat_feishu_done_without_device_code_regenerates_auth_guidance(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    session = get_session_manager().create_session(user_id="alice", model="codex-medium")
    session.pending_connector_auth = {
        "connector": "feishu",
        "stage": "awaiting_user_auth",
        "resume_user_input": "用飞书给胡畔发 hi",
    }
    get_session_manager().persist_session(session)

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device/retry",
            "device_code": "device-retry",
        }

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session.session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "https://accounts.feishu.cn/device/retry" in body["choices"][0]["message"]["content"]
    assert provider.requests == []


def test_chat_feishu_done_with_pending_device_code_does_not_repeat_auth_link(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    monkeypatch.setattr(registry, "_FEISHU_AUTH_CONFIRM_DELAYS_SECONDS", (0.0,))

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        assert device_code == "device-pending"
        return False, "authorization_pending"

    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    session = get_session_manager().create_session(user_id="alice", model="codex-medium")
    session.pending_connector_auth = {
        "connector": "feishu",
        "stage": "awaiting_user_auth",
        "resume_user_input": "用飞书给胡畔发 hi",
        "device_code": "device-pending",
        "oauth_url": "https://accounts.feishu.cn/device/pending",
    }
    get_session_manager().persist_session(session)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session.session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    content = body["choices"][0]["message"]["content"]
    assert body["connector_auth"]["stage"] == "pending"
    assert "[FEISHU_AUTH]" not in content
    assert "https://accounts.feishu.cn/device/pending" not in content
    assert "重新授权" in content
    assert provider.requests == []


def test_chat_feishu_complete_failure_rechecks_status_and_resumes(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="sent")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    monkeypatch.setattr(registry, "_FEISHU_AUTH_CONFIRM_DELAYS_SECONDS", (0.0, 0.0, 0.0))
    status_values = [
        (False, "not ready before preflight", {"has_app_config": True}),
        (False, "not ready before auth start", {"has_app_config": True}),
        (False, "not ready before complete", {"has_app_config": True}),
        (False, "not ready immediately after complete", {"has_app_config": True}),
        (True, "ready after browser confirmation settled", {"has_app_config": True, "open_id": "ou_me"}),
    ]
    complete_calls = 0

    def fake_status(config, user_id):
        if status_values:
            return status_values.pop(0)
        return True, "ready", {"has_app_config": True, "open_id": "ou_me"}

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-final-confirm",
        }

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        nonlocal complete_calls
        complete_calls += 1
        assert device_code == "device-final-confirm"
        return (
            False,
            "以上结果是本次授权请求用户最终确认后的结果，请勿持续重试；"
            "可执行 lark-cli auth status 查看账号当前已授予的全部 scopes；",
        )

    monkeypatch.setattr(registry, "feishu_cli_login_status", fake_status)
    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "用飞书给胡畔发 hi"}],
        },
    )
    assert first.status_code == 200
    assert first.json()["connector_auth"]["stage"] == "awaiting_user_auth"

    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "authorized"
    assert second.json()["choices"][0]["message"]["content"] == "sent"
    assert "请勿持续重试" not in second.text
    assert complete_calls == 1
    assert len(provider.requests) == 1
    assert "用飞书给胡畔发 hi" in provider.requests[0].prompt


def test_chat_feishu_finalized_device_code_does_not_retry_complete(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    monkeypatch.setattr(registry, "_FEISHU_AUTH_CONFIRM_DELAYS_SECONDS", (0.0,))
    complete_calls = 0

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "still not ready", {"has_app_config": True}),
    )

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        nonlocal complete_calls
        complete_calls += 1
        return (
            False,
            "以上结果是本次授权请求用户最终确认后的结果，请勿持续重试；"
            "可执行 lark-cli auth status 查看账号当前已授予的全部 scopes；",
        )

    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    session = get_session_manager().create_session(user_id="alice", model="codex-medium")
    session.pending_connector_auth = {
        "connector": "feishu",
        "stage": "awaiting_user_auth",
        "resume_user_input": "用飞书给胡畔发 hi",
        "device_code": "device-finalized",
        "oauth_url": "https://accounts.feishu.cn/device/finalized",
    }
    get_session_manager().persist_session(session)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session.session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )
    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session.session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert complete_calls == 1
    assert "请勿持续重试" not in first.text
    assert "https://accounts.feishu.cn/device/finalized" not in second.text
    assert provider.requests == []


def test_chat_feishu_invalid_app_config_restarts_setup_before_user_auth(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    config = get_session_manager().sandbox_manager.config
    config.lark_cli_bin = str(tmp_path / "lark-cli")
    cli_config = config.workspace_dir("alice") / ".lark-cli" / "config.json"
    cli_config.parent.mkdir(parents=True, exist_ok=True)
    cli_config.write_text("{}", encoding="utf-8")
    ensure_force_values: list[bool] = []

    class FakeCompletedProcess:
        def __init__(self, stdout: str, returncode: int = 0):
            self.stdout = stdout
            self.stderr = ""
            self.returncode = returncode

    def fake_run(argv, **kwargs):
        command = argv[-1]
        if "doctor" in command:
            return FakeCompletedProcess(
                json.dumps(
                    {
                        "checks": [
                            {"name": "config_file", "status": "pass"},
                            {"name": "app_resolved", "status": "fail", "message": "app not resolved"},
                            {"name": "token_exists", "status": "fail"},
                        ]
                    }
                )
            )
        raise AssertionError(f"unexpected command: {command}")

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        ensure_force_values.append(force_new_setup)
        if force_new_setup:
            return False, "https://open.feishu.cn/page/cli?user_code=RESETUP"
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        raise AssertionError("user auth must not start before app setup is valid")

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "write_nsjail_config", lambda config, user_id: None)
    monkeypatch.setattr(registry, "build_nsjail_argv", lambda config, user_id, command: ["sh", "-c", command])
    monkeypatch.setattr(registry.subprocess, "run", fake_run)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "使用飞书cli给胡畔发 hi"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["connector_auth"]["stage"] == "awaiting_setup"
    assert "[FEISHU_SETUP]" in body["choices"][0]["message"]["content"]
    assert "https://open.feishu.cn/page/cli?user_code=RESETUP" in body["choices"][0]["message"]["content"]
    assert ensure_force_values == [False, True]
    assert provider.requests == []


def test_chat_feishu_auth_completion_resumes_original_request(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="sent")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-789",
        }

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        assert device_code == "device-789"
        return True, "authorized"

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "用飞书给胡畔发 hi"}],
        },
    )

    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )

    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "authorized"
    assert second.json()["choices"][0]["message"]["content"] == "sent"
    assert len(provider.requests) == 1
    assert "用飞书给胡畔发 hi" in provider.requests[0].prompt
    assert "好了" not in provider.requests[0].prompt


def test_task_feishu_auth_poll_resumes_original_request_without_user_done(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="sent")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-poll-auth",
        }

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        assert device_code == "device-poll-auth"
        return True, "authorized"

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "用飞书给胡畔发 hi"}],
        },
    )
    assert first.status_code == 200
    session_id = first.json()["session_id"]

    second = client.post(
        f"/v1/tasks/{session_id}/connector-auth/poll",
        json={"model": "codex-medium", "stream": False},
    )

    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "authorized"
    assert second.json()["choices"][0]["message"]["content"] == "sent"
    assert len(provider.requests) == 1
    assert "用飞书给胡畔发 hi" in provider.requests[0].prompt
    assert "好了" not in provider.requests[0].prompt

    session = client.get(f"/v1/sessions/{session_id}")
    messages = session.json()["messages"]
    user_texts = [
        block["text"]
        for message in messages
        if message["type"] == "user"
        for block in message["message"]["content"]
        if block.get("type") == "text"
    ]
    assert user_texts == ["用飞书给胡畔发 hi"]


def test_task_google_auth_poll_resumes_original_request_without_user_done(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="gmail summary")
    client = _client(tmp_path, monkeypatch, provider)
    config = get_session_manager().sandbox_manager.config
    config.gogcli_cli_install_root = str(tmp_path / "gogcli")
    keyring_file = config.workspace_dir("alice") / ".config" / "gogcli" / "keyring" / "token"
    keyring_file.parent.mkdir(parents=True, exist_ok=True)
    keyring_file.write_text("encrypted-token", encoding="utf-8")

    session = get_session_manager().create_session(user_id="alice", model="codex-medium")
    session.pending_connector_auth = {
        "connector": "google_workspace",
        "stage": "awaiting_browser_callback",
        "resume_user_input": "查看 echonoshy@gmail.com 最近1天的 gmail",
        "callback_mode": "assisted",
        "oauth_url": "https://accounts.google.com/o/oauth2/auth?state=state-123",
    }
    get_session_manager().persist_session(session)

    response = client.post(
        f"/v1/tasks/{session.session_id}/connector-auth/poll",
        json={"model": "codex-medium", "stream": False},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["connector_auth"]["connector"] == "google_workspace"
    assert body["connector_auth"]["stage"] == "authorized"
    assert body["choices"][0]["message"]["content"] == "gmail summary"
    assert len(provider.requests) == 1
    assert "查看 echonoshy@gmail.com 最近1天的 gmail" in provider.requests[0].prompt
    assert "好了" not in provider.requests[0].prompt


def test_chat_feishu_auth_completion_stream_splits_auth_notice_from_resumed_output(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="sent")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")

    monkeypatch.setattr(
        registry,
        "feishu_cli_login_status",
        lambda config, user_id: (False, "no user logged in", {"has_app_config": True}),
    )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-stream",
        }

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        assert device_code == "device-stream"
        return True, "authorized"

    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "用飞书给胡畔发 hi"}],
        },
    )
    assert first.status_code == 200
    assert first.json()["connector_auth"]["stage"] == "awaiting_user_auth"

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": True,
            "messages": [{"role": "user", "content": "好了"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    new_turn_marker = '"type": "new_turn"'
    assert response.status_code == 200
    assert '"stage": "authorized"' in body
    assert new_turn_marker in body
    assert body.index("飞书授权已完成。继续执行刚才的请求。") < body.index(new_turn_marker)
    assert body.index(new_turn_marker) < body.index('"content": "sent"')
    assert len(provider.requests) == 1
    assert "用飞书给胡畔发 hi" in provider.requests[0].prompt


def test_chat_feishu_setup_then_auth_completion_resumes_original_request(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="sent")
    client = _client(tmp_path, monkeypatch, provider)
    get_session_manager().sandbox_manager.config.lark_cli_bin = str(tmp_path / "lark-cli")
    app_configured = False
    user_authorized = False

    def fake_status(config, user_id):
        return (
            user_authorized,
            "ready" if user_authorized else "not ready",
            {"has_app_config": app_configured},
        )

    async def fake_ensure_lark_cli_config(config, user_id, *, force_new_setup=False):
        nonlocal app_configured
        if not app_configured:
            app_configured = True
            return False, "https://open.feishu.cn/page/cli?user_code=SETUP"
        return True, ""

    async def fake_start_lark_user_auth(config, user_id, *, force_new=False):
        assert force_new is True
        return True, {
            "oauth_url": "https://accounts.feishu.cn/device",
            "device_code": "device-full-flow",
        }

    async def fake_complete_lark_user_auth(config, user_id, device_code):
        nonlocal user_authorized
        assert device_code == "device-full-flow"
        user_authorized = True
        return True, "authorized"

    monkeypatch.setattr(registry, "feishu_cli_login_status", fake_status)
    monkeypatch.setattr(registry, "ensure_lark_cli_config", fake_ensure_lark_cli_config)
    monkeypatch.setattr(registry, "start_lark_user_auth", fake_start_lark_user_auth)
    monkeypatch.setattr(registry, "complete_lark_user_auth", fake_complete_lark_user_auth)

    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "使用 feishu cli 给胡畔发 hi"}],
        },
    )
    assert first.status_code == 200
    assert first.json()["connector_auth"]["stage"] == "awaiting_setup"
    assert "[FEISHU_SETUP]" in first.json()["choices"][0]["message"]["content"]
    assert provider.requests == []

    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )
    assert second.status_code == 200
    assert second.json()["connector_auth"]["stage"] == "awaiting_user_auth"
    assert "[FEISHU_AUTH]" in second.json()["choices"][0]["message"]["content"]
    assert provider.requests == []

    third = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": first.json()["session_id"],
            "stream": False,
            "messages": [{"role": "user", "content": "好了"}],
        },
    )
    assert third.status_code == 200
    assert third.json()["connector_auth"]["stage"] == "authorized"
    assert third.json()["choices"][0]["message"]["content"] == "sent"
    assert len(provider.requests) == 1
    assert "使用 feishu cli 给胡畔发 hi" in provider.requests[0].prompt
    assert "好了" not in provider.requests[0].prompt


def test_chat_completions_rejects_new_session_when_session_quota_is_exhausted(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    update = client.put("/v1/users/alice/quota", json={"max_sessions": 0})
    assert update.status_code == 200

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "Hello"}],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["resource"] == "sessions"
    assert provider.requests == []


def test_chat_completions_rejects_when_daily_run_quota_is_exhausted(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="should not run")
    client = _client(tmp_path, monkeypatch, provider)
    update = client.put("/v1/users/alice/quota", json={"max_runs_per_day": 0})
    assert update.status_code == 200

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "Hello"}],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["resource"] == "runs_per_day"
    assert provider.requests == []


def test_chat_completion_runs_are_counted_in_user_quota_usage(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="counted")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "Hello"}],
        },
    )
    assert response.status_code == 200

    quota = client.get("/v1/users/me/quota")
    assert quota.status_code == 200
    assert quota.json()["usage"]["runs_today"] == 1


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


@pytest.mark.asyncio
async def test_streaming_approval_event_does_not_hold_session_lock(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="unused")
    _client(tmp_path, monkeypatch, provider)
    manager = get_session_manager()
    session = manager.create_session(user_id="alice", model="codex-medium")

    events_file = tmp_path / "approval-events.jsonl"
    events_file.write_text(
        json.dumps(
            AgentRunnerEvent(
                type="codex.approval_request",
                job_id="job-approval",
                provider="codex",
                data={
                    "approval": {
                        "source": "codex",
                        "job_id": "job-approval",
                        "request_id": "approval-1",
                        "description": "Run command",
                    }
                },
            ).model_dump(mode="json"),
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    class RunningJob:
        job_id = "job-approval"
        status = AgentRunnerStatus.RUNNING

    RunningJob.events_file = events_file

    monkeypatch.setattr(codex_chat, "_start_chat_run", lambda **_kwargs: RunningJob())

    generator = codex_chat.stream_codex_chat_as_sse(
        session=session,
        user_input="Needs approval",
        input_items=[],
        user_content=[{"type": "text", "text": "Needs approval"}],
        attachment_items=[],
        model="gpt-5.5",
        effort=None,
        summary=None,
        output_schema=None,
        system_prompt="system",
        manager=manager,
        agent_manager=ExternalAgentManager(providers={}),
        config=get_config(),
    )
    try:
        assert '"role": "assistant"' in await asyncio.wait_for(generator.__anext__(), timeout=1)
        approval_chunk = await asyncio.wait_for(generator.__anext__(), timeout=1)
        assert '"type": "approval_required"' in approval_chunk

        await asyncio.wait_for(session.lock.acquire(), timeout=0.2)
        session.lock.release()
    finally:
        await generator.aclose()


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


def test_chat_completions_stream_suppresses_commentary_updates(tmp_path: Path, monkeypatch):
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
    assert '"type": "assistant_update_delta"' not in body
    assert '"type": "assistant_update"' not in body
    assert "working" not in body
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
    assert '"prompt_tokens": 60' in body
    assert '"completion_tokens": 20' in body
    assert '"total_tokens": 90' in body
    assert '"last_prompt_tokens": 90' in body
    assert '"model_context_window": 200000' in body


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


def test_chat_completions_stream_bridges_runtime_events_to_sse(tmp_path: Path, monkeypatch):
    provider = CodexRuntimeEventProvider()
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Show runtime events"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "codex_turn_diff_updated"' in body
    assert '"type": "tool_output_delta"' in body
    assert '"kind": "command_execution"' in body
    assert '"type": "file_change_patch_updated"' in body
    assert '"type": "codex_warning"' in body
    assert '"type": "codex_error"' in body
    assert '"type": "context_compaction"' in body
    assert '"content": "done"' in body


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


def _schedule_extraction_json(**schedule_overrides) -> str:
    schedule = {
        "title": "新建日期 Markdown 文件",
        "prompt": "在执行时使用当前本地日期生成 yyyy-mm-dd.md 文件，内容随便写一段简短文本。",
        "kind": "once",
        "timezone": "Asia/Shanghai",
        "run_at": "2026-05-19T20:47:33+08:00",
        "interval_seconds": None,
        "enabled": True,
        "cwd": ".",
        "model": None,
        "effort": None,
        "summary": None,
        "output_schema": None,
        "max_runtime_seconds": 1800,
        "max_runs": None,
    }
    schedule.update(schedule_overrides)
    return json.dumps(
        {
            "is_schedule_request": True,
            "missing_fields": [],
            "clarification_question": None,
            "schedule": schedule,
        },
        ensure_ascii=False,
    )


def test_schedule_extraction_output_schema_is_strict_openai_compatible():
    def assert_strict_objects(schema: dict[str, Any], path: str = "$") -> None:
        schema_type = schema.get("type")
        if schema_type == "object" or (isinstance(schema_type, list) and "object" in schema_type):
            assert schema.get("additionalProperties") is False, path
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for name, child in properties.items():
                if isinstance(child, dict):
                    assert_strict_objects(child, f"{path}.properties.{name}")
        items = schema.get("items")
        if isinstance(items, dict):
            assert_strict_objects(items, f"{path}.items")
        for combiner in ("anyOf", "allOf", "oneOf"):
            entries = schema.get(combiner)
            if isinstance(entries, list):
                for index, child in enumerate(entries):
                    if isinstance(child, dict):
                        assert_strict_objects(child, f"{path}.{combiner}[{index}]")

    assert_strict_objects(SCHEDULE_EXTRACTION_OUTPUT_SCHEMA)
    schedule_properties = SCHEDULE_EXTRACTION_OUTPUT_SCHEMA["properties"]["schedule"]["properties"]
    assert schedule_properties["summary"] == {"type": "null"}
    assert schedule_properties["output_schema"] == {"type": "null"}


def test_chat_schedule_intent_uses_structured_extraction_and_persists_confirmation(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output=_schedule_extraction_json())
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "帮我定一个2分钟以后的定时任务，新建一个文件"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assistant_text = body["choices"][0]["message"]["content"]
    assert "我可以创建这个定时任务" in assistant_text
    assert body["event"]["type"] == "schedule_proposed"
    assert body["event"]["schedule"]["run_at"] == "2026-05-19T20:47:33+08:00"
    assert provider.requests[0].output_schema == SCHEDULE_EXTRACTION_OUTPUT_SCHEMA
    assert "strict schedule-request extractor" in provider.requests[0].prompt
    assert "帮我定一个2分钟以后的定时任务" in provider.requests[0].prompt

    manager = get_session_manager()
    session = manager.get_session(body["session_id"], user_id="alice")
    assert session is not None
    assert session.status == "awaiting_user_input"
    assert session.pending_question == "要创建这个定时任务吗？"
    assert session.pending_options == ["确认创建", "取消"]
    assert session.pending_schedule_request["title"] == "新建日期 Markdown 文件"


def test_chat_schedule_intent_stream_emits_control_plane_ask_user_event(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output=_schedule_extraction_json())
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "帮我定一个2分钟以后的定时任务"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "schedule_proposed"' in body
    assert '"stop_reason": "ask_user"' in body
    assert "新建日期 Markdown 文件" in body


def test_chat_schedule_extraction_preserves_interval_run_limit(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(
        output=_schedule_extraction_json(kind="interval", interval_seconds=120, run_at=None, max_runs=3)
    )
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "每2分钟执行一次，总共执行3次"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event"]["type"] == "schedule_proposed"
    assert body["event"]["schedule"]["max_runs"] == 3
    assert "最多 3 次" in body["choices"][0]["message"]["content"]


def test_chat_schedule_extraction_can_ask_for_clarification(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(
        output=json.dumps(
            {
                "is_schedule_request": True,
                "missing_fields": ["run_at"],
                "clarification_question": "什么时候执行这个任务？",
                "schedule": None,
            },
            ensure_ascii=False,
        )
    )
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "帮我定一个定时任务"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event"]["type"] == "schedule_clarification_required"
    assert "什么时候执行" in body["choices"][0]["message"]["content"]

    manager = get_session_manager()
    session = manager.get_session(body["session_id"], user_id="alice")
    assert session is not None
    assert session.pending_schedule_request is None


def test_chat_schedule_extraction_failure_is_not_reported_as_user_clarification(tmp_path: Path, monkeypatch):
    provider = FailingCodexProvider()
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "帮我定一个2分钟以后的定时任务，新建一个文件"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event"]["type"] == "schedule_extraction_failed"
    assert "不是你的描述问题" in body["choices"][0]["message"]["content"]

    manager = get_session_manager()
    session = manager.get_session(body["session_id"], user_id="alice")
    assert session is not None
    assert session.status == "idle"
    assert session.pending_question is None
    assert session.pending_schedule_request is None


def test_chat_final_answer_json_is_not_used_as_schedule_protocol(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output='{"type": "one_time", "run_at": "2026-05-19T20:47:33+08:00"}')
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [{"role": "user", "content": "Show this JSON"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert "event" not in body
    assert body["choices"][0]["message"]["content"].startswith('{"type": "one_time"')

    manager = get_session_manager()
    session = manager.get_session(body["session_id"], user_id="alice")
    assert session is not None
    assert session.pending_schedule_request is None


def test_chat_confirming_pending_schedule_creates_schedule(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="unused")
    client = _client(tmp_path, monkeypatch, provider)
    manager = get_session_manager()
    session = manager.create_session(user_id="alice", model="codex-medium")
    session.pending_schedule_request = {
        "title": "Daily repo summary",
        "prompt": "Summarize repository changes.",
        "kind": "interval",
        "timezone": "UTC",
        "run_at": "2026-05-20T09:00:00+00:00",
        "interval_seconds": 86400,
        "enabled": True,
        "cwd": None,
        "model": None,
        "effort": None,
        "summary": None,
        "output_schema": None,
        "max_runtime_seconds": 1800,
    }
    session.pending_question = "要创建这个定时任务吗？"
    session.pending_options = ["确认创建", "取消"]
    session.status = "awaiting_user_input"

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session.session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "确认创建"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert "已创建定时任务" in body["choices"][0]["message"]["content"]
    assert body["event"]["type"] == "schedule_created"
    assert provider.requests == []
    assert session.pending_schedule_request is None
    assert session.pending_question is None
    assert session.status == "idle"

    schedules = client.get("/v1/schedules").json()["schedules"]
    assert len(schedules) == 1
    assert schedules[0]["title"] == "Daily repo summary"
    assert get_schedule(manager.sandbox_manager.config, "alice", schedules[0]["schedule_id"]) is not None


def test_chat_confirming_invalid_pending_schedule_clears_waiting_state(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="unused")
    client = _client(tmp_path, monkeypatch, provider)
    manager = get_session_manager()
    session = manager.create_session(user_id="alice", model="codex-medium")
    session.pending_schedule_request = {
        "title": "",
        "prompt": "Summarize repository changes.",
        "kind": "interval",
        "timezone": "UTC",
        "run_at": "2026-05-20T09:00:00+00:00",
        "interval_seconds": 86400,
        "enabled": True,
        "max_runtime_seconds": 1800,
    }
    session.pending_question = "要创建这个定时任务吗？"
    session.pending_options = ["确认创建", "取消"]
    session.status = "awaiting_user_input"

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "session_id": session.session_id,
            "stream": False,
            "messages": [{"role": "user", "content": "确认创建"}],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "title is required"
    assert session.pending_schedule_request is None
    assert session.pending_question is None
    assert session.pending_options is None
    assert session.status == "idle"

    detail = client.get(f"/v1/tasks/{session.session_id}").json()
    assert detail["status"] == "idle"
