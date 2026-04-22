"""Tests for ripple.sandbox.gogcli."""

import json
from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.gogcli import (
    GogcliClientConfig,
    ensure_gogcli_keyring_password,
    read_gogcli_client_config,
    write_gogcli_client_config,
)


@pytest.fixture
def cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
    )


def test_write_then_read_client_config_installed(cfg: SandboxConfig):
    raw = json.dumps({"installed": {"client_id": "abc123", "client_secret": "sec456"}})
    written = write_gogcli_client_config(cfg, "alice", raw)
    assert written == GogcliClientConfig(client_id="abc123", client_secret="sec456")

    got = read_gogcli_client_config(cfg, "alice")
    assert got == GogcliClientConfig(client_id="abc123", client_secret="sec456")

    f = cfg.gogcli_client_config_file("alice")
    assert oct(f.stat().st_mode)[-3:] == "600"


def test_write_client_config_web_variant(cfg: SandboxConfig):
    raw = json.dumps({"web": {"client_id": "w-id", "client_secret": "w-sec"}})
    written = write_gogcli_client_config(cfg, "bob", raw)
    assert written.client_id == "w-id"


def test_write_client_config_rejects_invalid_json(cfg: SandboxConfig):
    with pytest.raises(ValueError, match="不是合法 JSON"):
        write_gogcli_client_config(cfg, "alice", "not-json-at-all")


def test_write_client_config_rejects_missing_fields(cfg: SandboxConfig):
    raw = json.dumps({"installed": {"client_id": "only-id"}})
    with pytest.raises(ValueError, match="client_secret"):
        write_gogcli_client_config(cfg, "alice", raw)


def test_read_client_config_returns_none_when_missing(cfg: SandboxConfig):
    assert read_gogcli_client_config(cfg, "alice") is None


def test_read_client_config_returns_none_when_corrupted(cfg: SandboxConfig):
    f = cfg.gogcli_client_config_file("alice")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("{not valid json")
    assert read_gogcli_client_config(cfg, "alice") is None


def test_ensure_keyring_password_generates_and_persists(cfg: SandboxConfig):
    pw1 = ensure_gogcli_keyring_password(cfg, "alice")
    assert len(pw1) >= 32

    pw2 = ensure_gogcli_keyring_password(cfg, "alice")
    assert pw1 == pw2

    f = cfg.gogcli_keyring_pass_file("alice")
    assert oct(f.stat().st_mode)[-3:] == "600"


def test_ensure_keyring_password_different_per_user(cfg: SandboxConfig):
    pw_alice = ensure_gogcli_keyring_password(cfg, "alice")
    pw_bob = ensure_gogcli_keyring_password(cfg, "bob")
    assert pw_alice != pw_bob


def test_ensure_keyring_password_creates_credentials_dir(cfg: SandboxConfig):
    assert not cfg.gogcli_keyring_pass_file("alice").parent.exists()
    ensure_gogcli_keyring_password(cfg, "alice")
    assert cfg.gogcli_keyring_pass_file("alice").parent.exists()
    assert cfg.gogcli_keyring_pass_file("alice").exists()
