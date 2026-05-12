"""Shared ChatGPT/Codex OAuth credentials and device-code login helpers."""

import json
import time
from dataclasses import dataclass
from typing import Any

import httpx

from ripple.sandbox.config import SandboxConfig

OPENAI_AUTH_BASE_URL = "https://auth.openai.com"
OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
OPENAI_CODEX_DEVICE_VERIFY_URL = f"{OPENAI_AUTH_BASE_URL}/codex/device"
OPENAI_CODEX_DEVICE_CALLBACK_URL = f"{OPENAI_AUTH_BASE_URL}/deviceauth/callback"


@dataclass(frozen=True)
class OpenAICodexCredentials:
    access: str
    refresh: str
    expires: int


@dataclass(frozen=True)
class OpenAICodexDeviceLogin:
    device_auth_id: str
    user_code: str
    verification_url: str
    interval_seconds: int
    expires_in_seconds: int = 900


def read_credentials_file(path) -> OpenAICodexCredentials | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    access = _clean_string(data.get("access"))
    refresh = _clean_string(data.get("refresh"))
    expires = data.get("expires")
    if not access or not refresh or not isinstance(expires, int):
        return None
    return OpenAICodexCredentials(access=access, refresh=refresh, expires=expires)


def read_shared_credentials(config: SandboxConfig) -> OpenAICodexCredentials | None:
    return read_credentials_file(config.openai_codex_shared_credentials_file())


def write_shared_credentials(config: SandboxConfig, credentials: OpenAICodexCredentials) -> None:
    write_credentials_file(config.openai_codex_shared_credentials_file(), credentials)


def write_credentials_file(path, credentials: OpenAICodexCredentials) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(
            {
                "access": credentials.access,
                "refresh": credentials.refresh,
                "expires": credentials.expires,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    tmp.chmod(0o600)
    tmp.replace(path)
    path.chmod(0o600)


async def start_device_login(client: Any | None = None) -> OpenAICodexDeviceLogin:
    if client is None:
        async with httpx.AsyncClient(timeout=30) as http_client:
            return await start_device_login(client=http_client)

    response = await client.post(
        f"{OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode",
        json={"client_id": OPENAI_CODEX_CLIENT_ID},
        headers={"Content-Type": "application/json"},
    )
    data = _json_response(response)
    if not response.is_success:
        raise RuntimeError(_format_error("OpenAI Codex device code request failed", response, data))

    device_auth_id = _clean_string(data.get("device_auth_id"))
    user_code = _clean_string(data.get("user_code")) or _clean_string(data.get("usercode"))
    if not device_auth_id or not user_code:
        raise RuntimeError("OpenAI Codex device code response missing device_auth_id or user_code")

    interval = data.get("interval")
    interval_seconds = int(interval) if isinstance(interval, int | float) and interval > 0 else 5
    return OpenAICodexDeviceLogin(
        device_auth_id=device_auth_id,
        user_code=user_code,
        verification_url=OPENAI_CODEX_DEVICE_VERIFY_URL,
        interval_seconds=interval_seconds,
    )


async def poll_device_login(
    device_auth_id: str,
    user_code: str,
    *,
    client: Any | None = None,
    now_ms: int | None = None,
) -> OpenAICodexCredentials | None:
    if client is None:
        async with httpx.AsyncClient(timeout=30) as http_client:
            return await poll_device_login(device_auth_id, user_code, client=http_client, now_ms=now_ms)

    response = await client.post(
        f"{OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token",
        json={"device_auth_id": device_auth_id, "user_code": user_code},
        headers={"Content-Type": "application/json"},
    )
    data = _json_response(response)
    if response.status_code in {403, 404}:
        return None
    if not response.is_success:
        raise RuntimeError(_format_error("OpenAI Codex device authorization failed", response, data))

    authorization_code = _clean_string(data.get("authorization_code"))
    code_verifier = _clean_string(data.get("code_verifier"))
    if not authorization_code or not code_verifier:
        raise RuntimeError("OpenAI Codex device authorization response missing exchange code")

    return await _exchange_device_code(
        authorization_code=authorization_code,
        code_verifier=code_verifier,
        client=client,
        now_ms=now_ms,
    )


async def _exchange_device_code(
    *,
    authorization_code: str,
    code_verifier: str,
    client: Any,
    now_ms: int | None = None,
) -> OpenAICodexCredentials:
    response = await client.post(
        f"{OPENAI_AUTH_BASE_URL}/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": authorization_code,
            "redirect_uri": OPENAI_CODEX_DEVICE_CALLBACK_URL,
            "client_id": OPENAI_CODEX_CLIENT_ID,
            "code_verifier": code_verifier,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    data = _json_response(response)
    if not response.is_success:
        raise RuntimeError(_format_error("OpenAI Codex token exchange failed", response, data))

    access = _clean_string(data.get("access_token"))
    refresh = _clean_string(data.get("refresh_token"))
    expires_in = data.get("expires_in")
    if not access or not refresh:
        raise RuntimeError("OpenAI Codex token exchange response missing OAuth tokens")
    expires_in_ms = int(expires_in) * 1000 if isinstance(expires_in, int | float) and expires_in > 0 else 0
    expires = (now_ms if now_ms is not None else int(time.time() * 1000)) + expires_in_ms
    return OpenAICodexCredentials(access=access, refresh=refresh, expires=expires)


async def refresh_credentials(
    credentials: OpenAICodexCredentials,
    *,
    client: Any | None = None,
    now_ms: int | None = None,
) -> OpenAICodexCredentials:
    if client is None:
        async with httpx.AsyncClient(timeout=30) as http_client:
            return await refresh_credentials(credentials, client=http_client, now_ms=now_ms)

    response = await client.post(
        f"{OPENAI_AUTH_BASE_URL}/oauth/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": credentials.refresh,
            "client_id": OPENAI_CODEX_CLIENT_ID,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    data = _json_response(response)
    if not response.is_success:
        raise RuntimeError(_format_error("OpenAI Codex token refresh failed", response, data))

    access = _clean_string(data.get("access_token"))
    refresh = _clean_string(data.get("refresh_token")) or credentials.refresh
    expires_in = data.get("expires_in")
    if not access:
        raise RuntimeError("OpenAI Codex token refresh response missing access token")
    expires_in_ms = int(expires_in) * 1000 if isinstance(expires_in, int | float) and expires_in > 0 else 0
    expires = (now_ms if now_ms is not None else int(time.time() * 1000)) + expires_in_ms
    return OpenAICodexCredentials(access=access, refresh=refresh, expires=expires)


def _json_response(response: Any) -> dict[str, Any]:
    try:
        data = json.loads(response.text)
    except (json.JSONDecodeError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def _format_error(prefix: str, response: Any, data: dict[str, Any]) -> str:
    error = _clean_string(data.get("error"))
    description = _clean_string(data.get("error_description"))
    if error and description:
        return f"{prefix}: {error} ({description})"
    if error:
        return f"{prefix}: {error}"
    text = _clean_string(getattr(response, "text", ""))
    return f"{prefix}: HTTP {response.status_code} {text}".strip()


def _clean_string(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""
