"""确认 create_sandbox 会在安装了 gogcli 时自动生成 keyring 密码。"""

from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import create_sandbox


@pytest.fixture
def cfg_with_gogcli(tmp_path: Path) -> SandboxConfig:
    # 伪造 gogcli 安装根（create_sandbox 内部会检查 config.gogcli_cli_install_root）
    gogcli_root = tmp_path / "vendor" / "gogcli-cli"
    (gogcli_root / "current" / "bin").mkdir(parents=True, exist_ok=True)
    (gogcli_root / "current" / "bin" / "gog").write_text("#!/bin/sh\n")
    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
        gogcli_cli_install_root=str(gogcli_root),
    )


@pytest.fixture
def cfg_without_gogcli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SandboxConfig:
    monkeypatch.setattr(
        "ripple.sandbox.config._discover_gogcli_cli_install_root",
        lambda: None,
    )
    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
        gogcli_cli_install_root=None,
    )


def test_create_sandbox_generates_keyring_password_when_gogcli_available(cfg_with_gogcli: SandboxConfig):
    create_sandbox(cfg_with_gogcli, "alice")
    pass_file = cfg_with_gogcli.gogcli_keyring_pass_file("alice")
    assert pass_file.exists()
    assert pass_file.stat().st_size > 0


def test_create_sandbox_idempotent_keyring_password(cfg_with_gogcli: SandboxConfig):
    create_sandbox(cfg_with_gogcli, "alice")
    pw1 = cfg_with_gogcli.gogcli_keyring_pass_file("alice").read_text()
    create_sandbox(cfg_with_gogcli, "alice")
    pw2 = cfg_with_gogcli.gogcli_keyring_pass_file("alice").read_text()
    assert pw1 == pw2


def test_create_sandbox_no_keyring_password_when_gogcli_not_installed(cfg_without_gogcli: SandboxConfig):
    create_sandbox(cfg_without_gogcli, "alice")
    pass_file = cfg_without_gogcli.gogcli_keyring_pass_file("alice")
    assert not pass_file.exists()
