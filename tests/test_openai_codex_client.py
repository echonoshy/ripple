import pytest

from ripple.messages.utils import create_system_message, create_user_message


def test_codex_payload_uses_responses_shape_without_anthropic_messages_shape():
    from ripple.api.openai_codex import OpenAICodexClient

    client = OpenAICodexClient(api_key="access-token")

    payload = client.build_payload_for_test(
        messages=[
            create_system_message("System instructions"),
            create_user_message("Hello"),
        ],
        tools=None,
        model="gpt-5.5",
        max_tokens=4096,
        reasoning_effort="xhigh",
        stream=True,
        extra={},
    )

    assert payload["model"] == "gpt-5.5"
    assert payload["stream"] is True
    assert payload["store"] is False
    assert payload["reasoning"] == {"effort": "xhigh"}
    assert payload["instructions"] == "System instructions"
    assert payload["input"] == [
        {"role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
    ]
    assert "max_output_tokens" not in payload
    assert "messages" not in payload
    assert "system" not in payload


def test_codex_payload_merges_raw_system_messages_into_instructions():
    from ripple.api.openai_codex import OpenAICodexClient

    client = OpenAICodexClient(api_key="access-token")

    payload = client.build_payload_for_test(
        messages=[
            {"role": "system", "content": "Default instructions"},
            create_system_message("Caller instructions"),
            {"role": "user", "content": "Hello"},
        ],
        tools=None,
        model="gpt-5.5",
        max_tokens=4096,
        reasoning_effort=None,
        stream=True,
        extra={},
    )

    assert payload["instructions"] == "Default instructions\n\nCaller instructions"
    assert payload["input"] == [
        {"role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
    ]


def test_codex_payload_forces_store_false_even_when_extra_requests_storage():
    from ripple.api.openai_codex import OpenAICodexClient

    client = OpenAICodexClient(api_key="access-token")

    payload = client.build_payload_for_test(
        messages=[create_user_message("Hello")],
        tools=None,
        model="gpt-5.5",
        max_tokens=4096,
        reasoning_effort=None,
        stream=True,
        extra={"store": True},
    )

    assert payload["store"] is False


def test_codex_payload_strips_unsupported_token_and_sampling_parameters():
    from ripple.api.openai_codex import OpenAICodexClient

    client = OpenAICodexClient(api_key="access-token")

    payload = client.build_payload_for_test(
        messages=[create_user_message("Hello")],
        tools=None,
        model="gpt-5.5",
        max_tokens=4096,
        reasoning_effort=None,
        stream=True,
        extra={
            "max_output_tokens": 123,
            "temperature": 0.2,
            "top_p": 0.9,
            "parallel_tool_calls": True,
        },
    )

    assert "max_output_tokens" not in payload
    assert "temperature" not in payload
    assert "top_p" not in payload
    assert "parallel_tool_calls" not in payload


@pytest.mark.asyncio
async def test_codex_sse_parser_emits_text_and_final_assistant_message():
    from ripple.api.openai_codex import parse_codex_sse_lines
    from ripple.messages.types import AssistantMessage, StreamEvent

    lines = _lines(
        {"type": "response.created", "response": {"id": "resp_1"}},
        {"type": "response.output_text.delta", "delta": "Hel"},
        {"type": "response.output_text.delta", "delta": "lo"},
        {
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "usage": {"input_tokens": 11, "output_tokens": 2},
            },
        },
    )

    items = [item async for item in parse_codex_sse_lines(_aiter(lines))]

    assert [item.type for item in items if isinstance(item, StreamEvent)] == [
        "stream_start",
        "stream_chunk",
        "stream_chunk",
        "stream_end",
    ]
    message = next(item for item in items if isinstance(item, AssistantMessage))
    assert message.message["id"] == "resp_1"
    assert message.message["content"] == [{"type": "text", "text": "Hello"}]
    assert message.message["usage"] == {"input_tokens": 11, "output_tokens": 2}


@pytest.mark.asyncio
async def test_codex_sse_parser_emits_tool_use_blocks_from_function_calls():
    from ripple.api.openai_codex import parse_codex_sse_lines
    from ripple.messages.types import AssistantMessage

    lines = _lines(
        {"type": "response.output_text.delta", "delta": "Checking."},
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "Read",
                "arguments": '{"path": "README.md"}',
            },
        },
        {"type": "response.completed", "response": {"id": "resp_2"}},
    )

    items = [item async for item in parse_codex_sse_lines(_aiter(lines))]

    message = next(item for item in items if isinstance(item, AssistantMessage))
    assert message.message["content"] == [
        {"type": "text", "text": "Checking."},
        {"type": "tool_use", "id": "call_1", "name": "Read", "input": {"path": "README.md"}},
    ]


@pytest.mark.asyncio
async def test_codex_client_refreshes_expired_credentials_file(tmp_path, monkeypatch):
    from ripple.api.openai_codex import OpenAICodexClient
    from ripple.sandbox.openai_codex import OpenAICodexCredentials, write_credentials_file

    credentials_file = tmp_path / "openai-codex.json"
    write_credentials_file(
        credentials_file,
        OpenAICodexCredentials(access="old-access", refresh="old-refresh", expires=1000),
    )
    refresh_calls = []

    async def fake_refresh(credentials):
        refresh_calls.append(credentials)
        return OpenAICodexCredentials(access="fresh-access", refresh="fresh-refresh", expires=9_999_999_999_999)

    monkeypatch.setattr("ripple.api.openai_codex.refresh_credentials", fake_refresh)
    monkeypatch.setattr("ripple.api.openai_codex.time.time", lambda: 10)

    client = OpenAICodexClient(credentials_file=credentials_file)

    token = await client.access_token_for_test()

    assert token == "fresh-access"
    assert refresh_calls == [OpenAICodexCredentials(access="old-access", refresh="old-refresh", expires=1000)]
    assert '"fresh-refresh"' in credentials_file.read_text(encoding="utf-8")


def _lines(*events: dict) -> list[str]:
    import json

    return [f"data: {json.dumps(event)}" for event in events]


async def _aiter(lines: list[str]):
    for line in lines:
        yield line
