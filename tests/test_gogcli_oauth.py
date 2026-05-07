from ripple.sandbox.gogcli_oauth import (
    GOGCLI_OAUTH_CALLBACK_PATH,
    build_gogcli_callback_auth_url,
    extract_oauth_state,
    gogcli_oauth_request_base_url,
    pop_pending_gogcli_oauth,
    register_pending_gogcli_oauth,
    resolve_gogcli_oauth_callback_url,
)


class DummyConfig:
    def __init__(self, values: dict[str, object]):
        self._values = values

    def get(self, key: str, default=None):
        return self._values.get(key, default)


def test_extract_oauth_state_from_google_url():
    url = "https://accounts.google.com/o/oauth2/auth?client_id=abc&state=state-123&scope=email"

    assert extract_oauth_state(url) == "state-123"


def test_resolve_gogcli_oauth_callback_url_prefers_explicit_url():
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.callback_url": "https://ripple.example/v1/sandboxes/gogcli/oauth/callback",
            "server.public_base_url": "https://ignored.example",
        }
    )

    assert (
        resolve_gogcli_oauth_callback_url(cfg)  # type: ignore[arg-type]
        == "https://ripple.example/v1/sandboxes/gogcli/oauth/callback"
    )


def test_resolve_gogcli_oauth_callback_url_uses_public_base_url():
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.callback_url": None,
            "server.public_base_url": "https://ripple.example/",
        }
    )

    assert resolve_gogcli_oauth_callback_url(cfg) == "https://ripple.example" + GOGCLI_OAUTH_CALLBACK_PATH  # type: ignore[arg-type]


def test_resolve_gogcli_oauth_callback_url_preserves_public_base_path():
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.callback_url": None,
            "server.public_base_url": "https://ripple.example/api-root/",
        }
    )

    assert (  # type: ignore[arg-type]
        resolve_gogcli_oauth_callback_url(cfg)
        == "https://ripple.example/api-root" + GOGCLI_OAUTH_CALLBACK_PATH
    )


def test_resolve_gogcli_oauth_callback_url_uses_request_base_url():
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.callback_url": None,
            "server.public_base_url": None,
            "server.gogcli_oauth.auto_from_request": True,
        }
    )

    assert (
        resolve_gogcli_oauth_callback_url(  # type: ignore[arg-type]
            cfg,
            request_base_url="http://localhost:8810",
        )
        == "http://localhost:8810" + GOGCLI_OAUTH_CALLBACK_PATH
    )


def test_resolve_gogcli_oauth_callback_url_can_disable_request_base_url():
    cfg = DummyConfig(
        {
            "server.gogcli_oauth.callback_url": None,
            "server.public_base_url": None,
            "server.gogcli_oauth.auto_from_request": False,
        }
    )

    assert resolve_gogcli_oauth_callback_url(cfg, request_base_url="http://localhost:8810") is None  # type: ignore[arg-type]


def test_gogcli_oauth_request_base_url_prefers_forwarded_headers():
    headers = {
        "host": "127.0.0.1:8810",
        "x-forwarded-host": "ripple.example",
        "x-forwarded-proto": "https",
    }

    assert (
        gogcli_oauth_request_base_url(headers, "http://127.0.0.1:8810/v1/chat/completions")
        == "https://ripple.example"
    )


def test_build_gogcli_callback_auth_url_uses_saved_redirect_uri():
    assert (
        build_gogcli_callback_auth_url(
            "https://ripple.example/v1/sandboxes/gogcli/oauth/callback",
            "code=abc&state=xyz",
        )
        == "https://ripple.example/v1/sandboxes/gogcli/oauth/callback?code=abc&state=xyz"
    )


def test_pending_gogcli_oauth_expires():
    register_pending_gogcli_oauth(
        state="expired-state",
        user_id="u1",
        email="user@example.com",
        redirect_uri="https://ripple.example/callback",
        ttl_seconds=-1,
    )

    assert pop_pending_gogcli_oauth("expired-state") is None
