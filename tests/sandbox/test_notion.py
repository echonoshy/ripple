"""notion token 的 uid 维度 API"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.notion import read_notion_token_uid, write_notion_token_uid
from ripple.sandbox.workspace import create_user_workspace


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_write_then_read(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    write_notion_token_uid(c, "alice", "ntn_abc123def456")
    assert read_notion_token_uid(c, "alice") == "ntn_abc123def456"


def test_read_missing_returns_none(tmp_path: Path):
    c = _cfg(tmp_path)
    assert read_notion_token_uid(c, "alice") is None


def test_tokens_isolated_between_users(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    create_user_workspace(c, "bob")
    write_notion_token_uid(c, "alice", "ntn_alice_token")
    write_notion_token_uid(c, "bob", "ntn_bob_token")
    assert read_notion_token_uid(c, "alice") == "ntn_alice_token"
    assert read_notion_token_uid(c, "bob") == "ntn_bob_token"
