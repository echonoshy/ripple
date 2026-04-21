"""notion token 的 user 维度 API"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.notion import read_notion_token, write_notion_token
from ripple.sandbox.workspace import create_sandbox


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_write_then_read(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")
    write_notion_token(c, "alice", "ntn_abc123def456")
    assert read_notion_token(c, "alice") == "ntn_abc123def456"


def test_read_missing_returns_none(tmp_path: Path):
    c = _cfg(tmp_path)
    assert read_notion_token(c, "alice") is None


def test_tokens_isolated_between_users(tmp_path: Path):
    c = _cfg(tmp_path)
    create_sandbox(c, "alice")
    create_sandbox(c, "bob")
    write_notion_token(c, "alice", "ntn_alice_token")
    write_notion_token(c, "bob", "ntn_bob_token")
    assert read_notion_token(c, "alice") == "ntn_alice_token"
    assert read_notion_token(c, "bob") == "ntn_bob_token"
