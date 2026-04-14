from pathlib import Path

import pytest

from interfaces.server.sse import _save_to_history
from ripple.messages.utils import create_assistant_message, create_tool_result_message
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.storage import load_session_state, save_session_state


def test_save_to_history_keeps_internal_message_objects():
    history_messages = []
    assistant_message = create_assistant_message(
        [
            {"type": "text", "text": "在给你标语之前，我想先确认一些信息。"},
            {
                "type": "tool_use",
                "id": "toolu_ask_user_1",
                "name": "AskUser",
                "input": {
                    "question": "Ripple 的目标用户是谁？",
                    "options": ["开发者", "企业", "普通用户"],
                },
            },
        ]
    )
    tool_result_message = create_tool_result_message(
        tool_use_id="toolu_ask_user_1",
        content='{"question":"Ripple 的目标用户是谁？","answer":"The agent loop has been paused.","options":["开发者","企业","普通用户"]}',
        tool_name="AskUser",
    )

    _save_to_history(history_messages, "帮我想一句标语", [assistant_message, tool_result_message])

    assert len(history_messages) == 3
    assert history_messages[0].type == "user"
    assert history_messages[1].type == "assistant"
    assert history_messages[2].type == "user"
    assert history_messages[1].message["content"][1]["type"] == "tool_use"
    assert history_messages[2].message["content"][0]["type"] == "tool_result"


def test_load_session_state_restores_internal_message_objects(tmp_path: Path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes")
    session_id = "srv-history-test"
    messages = [
        create_assistant_message(
            [
                {"type": "text", "text": "我需要先问你一个问题。"},
                {
                    "type": "tool_use",
                    "id": "toolu_ask_user_2",
                    "name": "AskUser",
                    "input": {"question": "喜欢什么风格？", "options": ["技术酷炫风", "简洁商务风"]},
                },
            ]
        ),
        create_tool_result_message(
            tool_use_id="toolu_ask_user_2",
            content='{"question":"喜欢什么风格？","answer":"The agent loop has been paused.","options":["技术酷炫风","简洁商务风"]}',
            tool_name="AskUser",
        ),
    ]

    save_session_state(
        config,
        session_id,
        messages=messages,
        model="sonnet",
        system_prompt="test prompt",
        max_turns=10,
    )
    state = load_session_state(config, session_id)

    assert state is not None
    restored_messages = state["messages"]
    assert len(restored_messages) == 2
    assert restored_messages[0].type == "assistant"
    assert restored_messages[1].type == "user"
    assert restored_messages[0].message["content"][1]["name"] == "AskUser"
    assert restored_messages[1].message["content"][0]["tool_use_id"] == "toolu_ask_user_2"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
