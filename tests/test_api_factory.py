from pathlib import Path

from ripple.api.anthropic import AnthropicClient
from ripple.api.factory import create_client


def _install_config(monkeypatch, path: Path) -> None:
    import ripple.utils.config as config_module

    config_module._config = config_module.Config(path)
    monkeypatch.setattr("ripple.api.factory.get_config", config_module.get_config)


def test_factory_keeps_anthropic_client_for_anthropic_provider(tmp_path, monkeypatch):
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
""",
        encoding="utf-8",
    )
    _install_config(monkeypatch, config_path)

    client = create_client("anthropic")

    assert isinstance(client, AnthropicClient)


def test_factory_creates_codex_client_for_codex_provider(tmp_path, monkeypatch):
    config_path = tmp_path / "settings.yaml"
    config_path.write_text(
        """
api:
  provider: "openai-codex"
  providers:
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
      auth: "oauth"
""",
        encoding="utf-8",
    )
    _install_config(monkeypatch, config_path)

    client = create_client("openai-codex")

    assert client.provider_type == "openai-codex-responses"
    assert client.provider_name == "openai-codex"
