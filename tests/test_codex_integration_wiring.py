from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncGenerator

import pytest

from ripple.api.base import LLMClient
from ripple.core.agent_loop import query
from ripple.core.context import AbortSignal, ToolOptions, ToolUseContext
from ripple.messages.types import AssistantMessage, Message, StreamEvent
from ripple.messages.utils import create_assistant_message


class _CapturingClient(LLMClient):
    provider_type = "test"
    provider_name = "test"

    def __init__(self):
        self.stream_kwargs: dict[str, Any] | None = None

    async def stream(
        self,
        messages: list[Message | dict[str, Any]],
        tools=None,
        model: str = "",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[AssistantMessage | StreamEvent, None]:
        self.stream_kwargs = {
            "messages": messages,
            "tools": tools,
            "model": model,
            "max_tokens": max_tokens,
            "thinking": thinking,
            **kwargs,
        }
        yield create_assistant_message([{"type": "text", "text": "ok"}], message_id="msg_1")

    async def complete(
        self,
        messages: list[Message | dict[str, Any]],
        model: str = "",
        max_tokens: int | None = None,
        thinking: bool | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return {"text": "ok", "usage": {}}


def _install_config(monkeypatch, path: Path) -> None:
    import ripple.utils.config as config_module

    config_module._config = config_module.Config(path)
    monkeypatch.setattr("interfaces.server.sessions.get_config", config_module.get_config)


def _write_codex_config(path: Path) -> None:
    path.write_text(
        """
api:
  provider: "anthropic"
  providers:
    anthropic:
      type: "anthropic"
      api_key: "anthropic-key"
      base_url: "https://api.anthropic.com"
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
      auth: "oauth"
model:
  presets:
    codex-high:
      openai-codex: "gpt-5.5"
      reasoning_effort: "high"
""",
        encoding="utf-8",
    )


def test_session_creation_uses_provider_from_codex_alias(tmp_path, monkeypatch):
    config_path = tmp_path / "settings.yaml"
    _write_codex_config(config_path)
    _install_config(monkeypatch, config_path)

    import interfaces.server.sessions as sessions

    calls = []

    def fake_create_client(provider=None, **kwargs):
        calls.append({"provider": provider, **kwargs})
        return _CapturingClient()

    monkeypatch.setattr(sessions, "create_client", fake_create_client)

    manager = sessions.SessionManager()
    session = manager.create_session(user_id="default", model="codex-high")

    assert calls[0]["provider"] == "openai-codex"
    assert session.model == "codex-high"
    assert session.context.options.provider == "openai-codex"
    assert session.context.options.model == "gpt-5.5"
    assert session.context.options.reasoning_effort == "high"


def test_existing_session_can_switch_to_codex_provider_without_reusing_anthropic_client(tmp_path, monkeypatch):
    config_path = tmp_path / "settings.yaml"
    config_path.write_text(
        """
api:
  provider: "anthropic"
  providers:
    anthropic:
      type: "anthropic"
      api_key: "anthropic-key"
      base_url: "https://api.anthropic.com"
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
      auth: "oauth"
model:
  default: "sonnet"
  presets:
    sonnet:
      anthropic: "claude-sonnet-4-6"
    codex-high:
      openai-codex: "gpt-5.5"
      reasoning_effort: "high"
""",
        encoding="utf-8",
    )
    _install_config(monkeypatch, config_path)

    import interfaces.server.sessions as sessions

    calls = []

    def fake_create_client(provider=None, **kwargs):
        client = _CapturingClient()
        client.provider_name = provider or "anthropic"
        calls.append({"provider": provider, "client": client, **kwargs})
        return client

    monkeypatch.setattr(sessions, "create_client", fake_create_client)

    manager = sessions.SessionManager()
    session = manager.create_session(user_id="default", model="sonnet")
    original_client = session.client

    resolved_model = manager.configure_session_model(session, "codex-high")

    assert calls[0]["provider"] == "anthropic"
    assert calls[-1]["provider"] == "openai-codex"
    assert session.client is not original_client
    assert session.model == "codex-high"
    assert resolved_model == "gpt-5.5"
    assert session.context.options.model == "gpt-5.5"
    assert session.context.options.provider == "openai-codex"
    assert session.context.options.reasoning_effort == "high"


def test_codex_provider_uses_server_shared_credentials_file(tmp_path, monkeypatch):
    config_path = tmp_path / "settings.yaml"
    config_path.write_text(
        """
api:
  provider: "openrouter"
  providers:
    openrouter:
      type: "openai"
      api_key: "openrouter-key"
      base_url: "https://openrouter.ai/api/v1"
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
      auth: "oauth"
model:
  presets:
    codex-high:
      openai-codex: "gpt-5.5"
      reasoning_effort: "high"
""",
        encoding="utf-8",
    )
    _install_config(monkeypatch, config_path)

    from interfaces.server.sessions import _credentials_file_for_provider
    from ripple.sandbox.config import SandboxConfig

    sandbox_config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        shared_credentials_root=tmp_path / "credentials",
    )
    sandbox_manager = SimpleNamespace(config=sandbox_config)

    credentials_file = _credentials_file_for_provider(
        "openai-codex",
        sandbox_manager=sandbox_manager,
        user_id="alice",
    )

    assert credentials_file == tmp_path / "credentials" / "openai-codex.json"


def test_codex_provider_ignores_user_id_for_credentials_file(tmp_path, monkeypatch):
    config_path = tmp_path / "settings.yaml"
    _write_codex_config(config_path)
    _install_config(monkeypatch, config_path)

    from interfaces.server.sessions import _credentials_file_for_provider
    from ripple.sandbox.config import SandboxConfig

    sandbox_config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        shared_credentials_root=tmp_path / "credentials",
    )
    sandbox_manager = SimpleNamespace(config=sandbox_config)

    credentials_file = _credentials_file_for_provider(
        "openai-codex",
        sandbox_manager=sandbox_manager,
        user_id="alice",
    )

    assert credentials_file == tmp_path / "credentials" / "openai-codex.json"


def test_server_does_not_register_openai_codex_auth_routes():
    from interfaces.server.routes import router

    route_paths = {getattr(route, "path", "") for route in router.routes}

    assert "/v1/sandboxes/openai-codex/status" not in route_paths
    assert "/v1/sandboxes/openai-codex/login/start" not in route_paths
    assert "/v1/sandboxes/openai-codex/login/poll" not in route_paths


@pytest.mark.asyncio
async def test_query_passes_reasoning_effort_to_client_stream():
    client = _CapturingClient()
    context = ToolUseContext(
        options=ToolOptions(model="gpt-5.5", provider="openai-codex", reasoning_effort="xhigh"),
        session_id="test-session",
        abort_signal=AbortSignal(),
    )

    items = [
        item
        async for item in query(
            "hello",
            context,
            client=client,
            model="gpt-5.5",
            max_turns=1,
            reasoning_effort="xhigh",
        )
    ]

    assert any(isinstance(item, AssistantMessage) for item in items)
    assert client.stream_kwargs is not None
    assert client.stream_kwargs["reasoning_effort"] == "xhigh"
