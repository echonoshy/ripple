"""nsjail.cfg 生成按 uid"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.nsjail_config import generate_nsjail_config_uid, write_nsjail_config_uid
from ripple.sandbox.workspace import create_user_workspace


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_generate_nsjail_config_uid_mentions_user_workspace(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    content = generate_nsjail_config_uid(c, "alice")
    expected_ws = str(c.workspace_dir_by_uid("alice"))
    assert expected_ws in content
    assert "ripple-sandbox-alice" in content


def test_write_nsjail_config_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    cfg_path = write_nsjail_config_uid(c, "alice")
    assert cfg_path == c.nsjail_cfg_file_by_uid("alice")
    assert cfg_path.exists()
