"""SandboxConfig gogcli-related paths."""

from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig


@pytest.fixture
def cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
    )


def test_gogcli_client_config_file_path(cfg: SandboxConfig):
    got = cfg.gogcli_client_config_file("alice")
    assert got == cfg.sandbox_dir("alice") / "credentials" / "gogcli-client.json"


def test_gogcli_keyring_pass_file_path(cfg: SandboxConfig):
    got = cfg.gogcli_keyring_pass_file("alice")
    assert got == cfg.sandbox_dir("alice") / "credentials" / "gogcli-keyring.pass"


def test_has_gogcli_client_config_false_when_missing(cfg: SandboxConfig):
    assert cfg.has_gogcli_client_config("alice") is False


def test_has_gogcli_client_config_true_when_present(cfg: SandboxConfig):
    f = cfg.gogcli_client_config_file("alice")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text('{"installed": {"client_id": "x", "client_secret": "y"}}')
    assert cfg.has_gogcli_client_config("alice") is True


def test_has_gogcli_login_false_when_no_creds_dir(cfg: SandboxConfig):
    assert cfg.has_gogcli_login("alice") is False


def test_has_gogcli_login_true_when_creds_dir_nonempty(cfg: SandboxConfig):
    # gogcli keyring backend=file 把加密 credentials 落在 $XDG_CONFIG_HOME/gogcli/keyring/
    # ripple 把 XDG_CONFIG_HOME 指到 /workspace/.config/，所以宿主路径是 workspace_dir/.config/gogcli/keyring/
    d = cfg.workspace_dir("alice") / ".config" / "gogcli" / "keyring"
    d.mkdir(parents=True, exist_ok=True)
    (d / "default.keyring").write_bytes(b"dummy-encrypted-blob")
    assert cfg.has_gogcli_login("alice") is True
