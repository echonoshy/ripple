import pytest

from ripple.sandbox.config import SandboxConfig


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | str):
        import json

        self.status_code = status_code
        self._text = json.dumps(body) if isinstance(body, dict) else body

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    @property
    def text(self) -> str:
        return self._text


class _FakeClient:
    def __init__(self, responses: list[_FakeResponse]):
        self.responses = responses
        self.requests = []

    async def post(self, url, **kwargs):
        self.requests.append({"url": url, **kwargs})
        return self.responses.pop(0)


def test_openai_codex_credentials_are_shared_only(tmp_path):
    from ripple.sandbox.openai_codex import OpenAICodexCredentials, read_shared_credentials, write_shared_credentials

    config = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "cache",
        shared_credentials_root=tmp_path / "credentials",
    )
    write_shared_credentials(
        config,
        OpenAICodexCredentials(access="shared-access", refresh="shared-refresh", expires=123456),
    )

    loaded = read_shared_credentials(config)

    assert loaded == OpenAICodexCredentials(access="shared-access", refresh="shared-refresh", expires=123456)
    assert config.openai_codex_shared_credentials_file() == tmp_path / "credentials" / "openai-codex.json"
    assert config.has_openai_codex_login("alice") is True
    assert config.has_openai_codex_login("bob") is True


@pytest.mark.asyncio
async def test_start_device_login_parses_openai_response():
    from ripple.sandbox.openai_codex import start_device_login

    client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "device_auth_id": "device-1",
                    "user_code": "ABCD-EFGH",
                    "interval": 3,
                },
            )
        ]
    )

    result = await start_device_login(client=client)

    assert result.device_auth_id == "device-1"
    assert result.user_code == "ABCD-EFGH"
    assert result.verification_url == "https://auth.openai.com/codex/device"
    assert result.interval_seconds == 3
    assert client.requests[0]["json"] == {"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}


@pytest.mark.asyncio
async def test_poll_device_login_returns_none_while_authorization_is_pending():
    from ripple.sandbox.openai_codex import poll_device_login

    client = _FakeClient([_FakeResponse(403, {"error": "authorization_pending"})])

    result = await poll_device_login("device-1", "ABCD-EFGH", client=client)

    assert result is None
    assert client.requests[0]["json"] == {"device_auth_id": "device-1", "user_code": "ABCD-EFGH"}


@pytest.mark.asyncio
async def test_poll_device_login_exchanges_authorization_code_for_credentials():
    from ripple.sandbox.openai_codex import poll_device_login

    client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "authorization_code": "auth-code",
                    "code_verifier": "verifier",
                },
            ),
            _FakeResponse(
                200,
                {
                    "access_token": "access-token",
                    "refresh_token": "refresh-token",
                    "expires_in": 3600,
                },
            ),
        ]
    )

    result = await poll_device_login("device-1", "ABCD-EFGH", client=client, now_ms=1000)

    assert result is not None
    assert result.access == "access-token"
    assert result.refresh == "refresh-token"
    assert result.expires == 3601000
    assert client.requests[1]["data"]["grant_type"] == "authorization_code"
    assert client.requests[1]["data"]["code"] == "auth-code"


@pytest.mark.asyncio
async def test_refresh_credentials_uses_refresh_token_grant():
    from ripple.sandbox.openai_codex import OpenAICodexCredentials, refresh_credentials

    client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "access_token": "fresh-access-token",
                    "refresh_token": "fresh-refresh-token",
                    "expires_in": 1800,
                },
            )
        ]
    )

    result = await refresh_credentials(
        OpenAICodexCredentials(access="old-access-token", refresh="old-refresh-token", expires=1000),
        client=client,
        now_ms=2000,
    )

    assert result.access == "fresh-access-token"
    assert result.refresh == "fresh-refresh-token"
    assert result.expires == 1802000
    assert client.requests[0]["data"] == {
        "grant_type": "refresh_token",
        "refresh_token": "old-refresh-token",
        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
    }
