import json
from pathlib import Path

from ripple.messages.utils import create_assistant_message, create_user_message
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.storage import load_session_state, save_session_state


def _save(config: SandboxConfig, messages: list) -> None:
    save_session_state(
        config,
        "alice",
        "session-1",
        messages=messages,
        model="codex-medium",
        caller_system_prompt=None,
        max_turns=10,
    )


def test_save_session_state_uses_messages_file_count_when_meta_count_is_stale(tmp_path: Path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    initial_messages = [
        create_user_message("first"),
        create_assistant_message([{"type": "text", "text": "reply"}]),
    ]
    _save(config, initial_messages)

    meta_file = config.meta_file("alice", "session-1")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    meta["message_count"] = 1
    meta_file.write_text(json.dumps(meta), encoding="utf-8")

    next_messages = [*initial_messages, create_user_message("second")]
    _save(config, next_messages)

    lines = [
        line for line in config.messages_file("alice", "session-1").read_text(encoding="utf-8").splitlines() if line
    ]
    assert len(lines) == 3
    assert [json.loads(line)["type"] for line in lines] == ["user", "assistant", "user"]


def test_save_session_state_treats_invalid_meta_message_count_as_zero(tmp_path: Path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    meta_file = config.meta_file("alice", "session-1")
    meta_file.parent.mkdir(parents=True)
    meta_file.write_text('{"message_count": "bad"}', encoding="utf-8")

    _save(config, [create_user_message("hello")])

    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    assert meta["message_count"] == 1


def test_save_session_state_persists_codex_thread_id(tmp_path: Path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")

    save_session_state(
        config,
        "alice",
        "session-1",
        messages=[create_user_message("hello")],
        model="codex-medium",
        caller_system_prompt=None,
        max_turns=10,
        codex_thread_id="thread-1",
    )

    state = load_session_state(config, "alice", "session-1")

    assert state is not None
    assert state["codex_thread_id"] == "thread-1"
