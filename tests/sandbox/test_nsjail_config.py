"""nsjail.cfg 生成按 user"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.nsjail_config import generate_nsjail_config, write_nsjail_config
from ripple.sandbox.workspace import create_sandbox


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_generate_nsjail_config_mentions_user_workspace(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")
    content = generate_nsjail_config(c, "alice")
    expected_ws = str(c.workspace_dir("alice"))
    assert expected_ws in content
    assert "ripple-sandbox-alice" in content


def test_write_nsjail_config(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")
    cfg_path = write_nsjail_config(c, "alice")
    assert cfg_path == c.nsjail_cfg_file("alice")
    assert cfg_path.exists()
