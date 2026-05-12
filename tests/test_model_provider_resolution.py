from pathlib import Path

import pytest

from ripple.utils.config import Config


def _write_config(path: Path) -> None:
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
  default: "sonnet"
  presets:
    sonnet:
      anthropic: "claude-sonnet-4-6"
      openrouter: "anthropic/claude-sonnet-4.6"
    codex-low:
      openai-codex: "gpt-5.5"
      reasoning_effort: "low"
    codex-xhigh:
      openai-codex: "gpt-5.5"
      reasoning_effort: "xhigh"
""",
        encoding="utf-8",
    )


def test_codex_alias_resolves_provider_model_and_reasoning_effort(tmp_path):
    config_path = tmp_path / "settings.yaml"
    _write_config(config_path)
    config = Config(config_path)

    resolved = config.resolve_model_info("codex-xhigh")

    assert resolved.provider == "openai-codex"
    assert resolved.provider_type == "openai-codex-responses"
    assert resolved.model == "gpt-5.5"
    assert resolved.reasoning_effort == "xhigh"
    assert config.resolve_model("codex-low") == "gpt-5.5"


def test_anthropic_alias_still_uses_current_provider_request_shape(tmp_path):
    config_path = tmp_path / "settings.yaml"
    _write_config(config_path)
    config = Config(config_path)

    resolved = config.resolve_model_info("sonnet")

    assert resolved.provider == "anthropic"
    assert resolved.provider_type == "anthropic"
    assert resolved.model == "claude-sonnet-4-6"
    assert resolved.reasoning_effort is None


def test_unknown_bare_model_keeps_current_provider_for_backward_compatibility(tmp_path):
    config_path = tmp_path / "settings.yaml"
    _write_config(config_path)
    config = Config(config_path)

    resolved = config.resolve_model_info("claude-opus-4-7")

    assert resolved.provider == "anthropic"
    assert resolved.provider_type == "anthropic"
    assert resolved.model == "claude-opus-4-7"


def test_openrouter_anthropic_model_id_keeps_current_provider_when_anthropic_provider_exists(tmp_path):
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
    anthropic:
      type: "anthropic"
      api_key: "anthropic-key"
      base_url: "https://api.anthropic.com"
model:
  presets: {}
""",
        encoding="utf-8",
    )
    config = Config(config_path)

    resolved = config.resolve_model_info("anthropic/claude-sonnet-4.6")

    assert resolved.provider == "openrouter"
    assert resolved.provider_type == "openai"
    assert resolved.model == "anthropic/claude-sonnet-4.6"


def test_unknown_reasoning_effort_is_rejected(tmp_path):
    config_path = tmp_path / "settings.yaml"
    config_path.write_text(
        """
api:
  provider: "openai-codex"
  providers:
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
model:
  presets:
    codex-fast:
      openai-codex: "gpt-5.5"
      reasoning_effort: "fast"
""",
        encoding="utf-8",
    )
    config = Config(config_path)

    with pytest.raises(ValueError, match="reasoning_effort"):
        config.resolve_model_info("codex-fast")


def test_codex_credentials_mode_defaults_and_validates(tmp_path):
    config_path = tmp_path / "settings.yaml"
    config_path.write_text(
        """
api:
  provider: "openai-codex"
  providers:
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
model:
  presets: {}
""",
        encoding="utf-8",
    )
    config = Config(config_path)

    assert config.openai_codex_credentials_mode("openai-codex") == "shared"

    config_path.write_text(
        """
api:
  provider: "openai-codex"
  providers:
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
      credentials_mode: "per_user"
model:
  presets: {}
""",
        encoding="utf-8",
    )
    config = Config(config_path)

    with pytest.raises(ValueError, match="shared-only"):
        config.openai_codex_credentials_mode("openai-codex")

    config_path.write_text(
        """
api:
  provider: "openai-codex"
  providers:
    openai-codex:
      type: "openai-codex-responses"
      base_url: "https://chatgpt.com/backend-api/codex"
      credentials_mode: "team"
model:
  presets: {}
""",
        encoding="utf-8",
    )
    config = Config(config_path)

    with pytest.raises(ValueError, match="credentials_mode"):
        config.openai_codex_credentials_mode("openai-codex")
