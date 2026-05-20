"""Host-side helper state for Google Workspace assisted OAuth callbacks.

Ripple owns the browser-facing OAuth URL and callback so users can choose their
Google account on Google's page without telling Ripple an email address first.
The resulting refresh token is still stored through gogcli's own import path.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from threading import RLock
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx

from ripple.utils.config import Config, get_config

GOGCLI_OAUTH_CALLBACK_PATH = "/v1/sandboxes/gogcli/oauth/callback"
GOGCLI_OAUTH_PENDING_TTL_SECONDS = 600
GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/auth"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_WORKSPACE_BASIC_SCOPES = (
    "email",
    "openid",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.settings.sharing",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.email",
)


@dataclass(frozen=True)
class PendingGogcliOAuth:
    user_id: str
    redirect_uri: str
    created_at: float
    expires_at: float
    email: str = ""


@dataclass(frozen=True)
class GoogleOAuthToken:
    access_token: str
    refresh_token: str


@dataclass(frozen=True)
class GoogleOAuthIdentity:
    email: str
    subject: str = ""


_LOCK = RLock()
_PENDING_BY_STATE: dict[str, PendingGogcliOAuth] = {}


def extract_oauth_state(oauth_url: str) -> str | None:
    """Extract the `state` query parameter from a Google OAuth URL."""
    try:
        parsed = urlparse(oauth_url)
    except ValueError:
        return None
    values = parse_qs(parsed.query).get("state")
    if not values:
        return None
    state = values[0].strip()
    return state or None


def _first_header_value(value: str | None) -> str:
    return (value or "").split(",", 1)[0].strip()


def _clean_base_url(raw: str | None, *, preserve_path: bool = False) -> str | None:
    value = (raw or "").strip()
    if not value:
        return None
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    path = parsed.path.rstrip("/") if preserve_path else ""
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def gogcli_oauth_request_base_url(headers: dict[str, str], request_url: str) -> str | None:
    """Infer the externally reachable API origin from an HTTP request.

    The browser talks to Ripple's API before gogcli OAuth starts. Reusing that
    API origin for the OAuth redirect keeps the callback outside the sandbox
    while still working behind normal reverse proxies.
    """
    lowered = {k.lower(): v for k, v in headers.items()}
    host = _first_header_value(lowered.get("x-forwarded-host")) or _first_header_value(lowered.get("host"))
    proto = _first_header_value(lowered.get("x-forwarded-proto"))
    if not proto:
        try:
            proto = urlparse(request_url).scheme
        except ValueError:
            proto = ""
    if not host or proto not in {"http", "https"}:
        return None
    return _clean_base_url(f"{proto}://{host}")


def resolve_gogcli_oauth_callback_url(
    config: Config | None = None,
    *,
    request_base_url: str | None = None,
) -> str | None:
    """Return the configured public callback URL for assisted gogcli OAuth.

    `server.gogcli_oauth.callback_url` is the precise override. As a less
    specific convenience, `server.public_base_url` can be set. When neither is
    set, the current request's API origin can be used if enabled.
    """
    cfg = config or get_config()
    explicit = (cfg.get("server.gogcli_oauth.callback_url") or "").strip()
    if explicit:
        return explicit

    base = (cfg.get("server.public_base_url") or "").strip()
    if base:
        clean_base = _clean_base_url(base, preserve_path=True)
        return clean_base + GOGCLI_OAUTH_CALLBACK_PATH if clean_base else None

    auto_from_request = cfg.get("server.gogcli_oauth.auto_from_request", True)
    if auto_from_request is False:
        return None
    clean_request_base = _clean_base_url(request_base_url)
    if not clean_request_base:
        return None
    return clean_request_base + GOGCLI_OAUTH_CALLBACK_PATH


def build_gogcli_callback_auth_url(redirect_uri: str, query_string: str) -> str:
    """Rebuild the public callback URL from the configured redirect URI.

    In proxied deployments, ASGI's `request.url` may use an internal host or
    scheme. The saved redirect URI is the one sent to Google in step 1, so use
    it as the base and append Google's returned query string.
    """
    query = (query_string or "").lstrip("?")
    if not query:
        return redirect_uri
    separator = "&" if "?" in redirect_uri else "?"
    return f"{redirect_uri}{separator}{query}"


def build_google_workspace_oauth_url(
    *,
    client_id: str,
    redirect_uri: str,
    state: str,
    scopes: tuple[str, ...] = GOOGLE_WORKSPACE_BASIC_SCOPES,
) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "state": state,
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent select_account",
    }
    return GOOGLE_OAUTH_AUTH_URL + "?" + urlencode(params)


async def exchange_google_oauth_code(
    *,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
    timeout: float = 15.0,
) -> GoogleOAuthToken:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                GOOGLE_OAUTH_TOKEN_URL,
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": redirect_uri,
                },
            )
    except httpx.HTTPError as exc:
        raise ValueError(f"Google token exchange request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text[:500] if response.text else response.reason_phrase
        raise ValueError(f"Google token exchange failed: HTTP {response.status_code}: {detail}")
    try:
        data = response.json()
    except ValueError as exc:
        raise ValueError("Google token exchange returned non-JSON response.") from exc
    if not isinstance(data, dict):
        raise ValueError("Google token exchange returned invalid response.")
    access_token = str(data.get("access_token") or "").strip()
    refresh_token = str(data.get("refresh_token") or "").strip()
    if not access_token:
        raise ValueError("Google token exchange did not return an access token.")
    if not refresh_token:
        raise ValueError("Google token exchange did not return a refresh token; try authorizing again.")
    return GoogleOAuthToken(access_token=access_token, refresh_token=refresh_token)


async def fetch_google_oauth_identity(
    *,
    access_token: str,
    timeout: float = 15.0,
) -> GoogleOAuthIdentity:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    except httpx.HTTPError as exc:
        raise ValueError(f"Google userinfo request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text[:500] if response.text else response.reason_phrase
        raise ValueError(f"Google userinfo request failed: HTTP {response.status_code}: {detail}")
    try:
        data = response.json()
    except ValueError as exc:
        raise ValueError("Google userinfo returned non-JSON response.") from exc
    if not isinstance(data, dict):
        raise ValueError("Google userinfo returned invalid response.")
    email = str(data.get("email") or "").strip()
    if not email:
        raise ValueError("Google userinfo did not return an email address.")
    subject = str(data.get("sub") or data.get("id") or "").strip()
    return GoogleOAuthIdentity(email=email, subject=subject)


def register_pending_gogcli_oauth(
    *,
    state: str,
    user_id: str,
    redirect_uri: str,
    email: str = "",
    ttl_seconds: int = GOGCLI_OAUTH_PENDING_TTL_SECONDS,
) -> PendingGogcliOAuth:
    now = time.time()
    pending = PendingGogcliOAuth(
        user_id=user_id,
        email=email,
        redirect_uri=redirect_uri,
        created_at=now,
        expires_at=now + ttl_seconds,
    )
    with _LOCK:
        _cleanup_expired_locked(now)
        _PENDING_BY_STATE[state] = pending
    return pending


def pop_pending_gogcli_oauth(state: str) -> PendingGogcliOAuth | None:
    now = time.time()
    with _LOCK:
        _cleanup_expired_locked(now)
        pending = _PENDING_BY_STATE.pop(state, None)
    if pending is None or pending.expires_at < now:
        return None
    return pending


def _cleanup_expired_locked(now: float) -> None:
    expired = [state for state, pending in _PENDING_BY_STATE.items() if pending.expires_at < now]
    for state in expired:
        _PENDING_BY_STATE.pop(state, None)
