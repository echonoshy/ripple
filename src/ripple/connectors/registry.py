"""Built-in connector registry and user-scoped auth actions."""

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ripple.connectors.base import (
    ConnectorActionResult,
    ConnectorInfo,
    ConnectorStatus,
    ConnectorUnsupportedError,
)
from ripple.sandbox.bilibili import (
    QRCODE_TTL_SECONDS,
    clear_bilibili_credential,
    qrcode_generate,
    qrcode_poll,
    read_bilibili_credential,
    verify_credential_live,
    write_bilibili_credential,
)
from ripple.sandbox.bilibili_gate import acquire_gate, release_gate
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN, SandboxConfig
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.feishu import complete_lark_user_auth, ensure_lark_cli_config, start_lark_user_auth
from ripple.sandbox.gogcli import (
    GOGCLI_BASIC_SERVICES_ARG,
    configured_gogcli_client_secret_json,
    ensure_gogcli_keyring_password,
    parse_auth_list_output,
)
from ripple.sandbox.gogcli_oauth import (
    extract_oauth_state,
    register_pending_gogcli_oauth,
    resolve_gogcli_oauth_callback_url,
)
from ripple.sandbox.gogcli_registration import GogcliClientRegistrationError, register_gogcli_client_config
from ripple.sandbox.notion import write_notion_token
from ripple.sandbox.nsjail_config import build_nsjail_argv, write_nsjail_config
from ripple.utils.logger import get_logger

logger = get_logger("connectors.registry")

_GOOGLE_OAUTH_URL_RE = re.compile(r"https://accounts\.google\.com/o/oauth2/[^\s]+")
_GOOGLE_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_GOOGLE_CALLBACK_URL_RE = re.compile(r"^https?://[^\s]+\?[^\s]+$")


def feishu_cli_login_status(config: SandboxConfig, user_id: str) -> tuple[bool, str, dict[str, Any]]:
    """Check whether lark-cli has a configured app and a user login."""
    if not config.lark_cli_bin:
        return False, "lark-cli is not installed for this server.", {"has_app_config": False}
    has_app_config = config.has_lark_cli_config(user_id)
    if not has_app_config:
        return False, "Feishu CLI app configuration is missing for this user.", {"has_app_config": False}

    try:
        write_nsjail_config(config, user_id)
        proc = subprocess.run(
            build_nsjail_argv(config, user_id, "lark-cli auth status 2>&1"),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Feishu auth status check failed: {exc}", {"has_app_config": True}

    output = (proc.stdout or "") + "\n" + (proc.stderr or "")
    metadata: dict[str, Any] = {"has_app_config": True}
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        for source, target in (
            ("identity", "identity"),
            ("open_id", "open_id"),
            ("openId", "open_id"),
            ("userOpenId", "open_id"),
            ("tenant_key", "tenant_key"),
            ("tenantKey", "tenant_key"),
        ):
            value = parsed.get(source)
            if isinstance(value, str) and value:
                metadata[target] = value
        error = parsed.get("error")
        if parsed.get("ok") is False:
            message = error.get("message") if isinstance(error, dict) else ""
            return False, message or "Feishu user authorization is missing.", metadata
    if proc.returncode == 0:
        return True, "Feishu user authorization is ready.", metadata
    detail = output.strip()[-500:] or "Feishu user authorization is missing."
    return False, detail, metadata


def _shq(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def _connector_path(name: str, suffix: str) -> str:
    return f"/v1/connectors/{name}/{suffix.lstrip('/')}"


def _not_supported(name: str, action: str) -> ConnectorUnsupportedError:
    return ConnectorUnsupportedError(f"Connector {name!r} does not support {action}")


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    return f"{value[:6]}...({len(value)} chars)"


def _payload_bool(payload: dict[str, Any], key: str, default: bool = False) -> bool:
    value = payload.get(key, default)
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no"}
    return bool(value)


def _safe_unlink(path: Path) -> bool:
    try:
        if path.exists():
            path.unlink()
            return True
    except OSError as exc:
        raise RuntimeError(f"Failed to remove {path.name}: {exc}") from exc
    return False


@dataclass(frozen=True)
class BaseConnector:
    info: ConnectorInfo

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        return ConnectorStatus(
            name=self.info.name,
            connected=False,
            required=True,
            detail=f"{self.info.display_name} status is not implemented.",
        )

    async def auth_start(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
        *,
        request_base_url: str | None = None,
    ) -> ConnectorActionResult:
        raise _not_supported(self.info.name, "auth_start")

    async def auth_complete(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        raise _not_supported(self.info.name, "auth_complete")

    async def disconnect(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        raise _not_supported(self.info.name, "disconnect")


@dataclass(frozen=True)
class StatusConnector(BaseConnector):
    status_method: str
    connected_detail: str
    missing_detail: str

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        connected = bool(getattr(config, self.status_method)(user_id))
        return ConnectorStatus(
            name=self.info.name,
            connected=connected,
            required=not connected,
            detail=self.connected_detail if connected else self.missing_detail,
        )


def _configured_codex_runtime() -> tuple[str, dict[str, str], str | None]:
    executable = "codex"
    extra_env: dict[str, str] = {}
    codex_home: str | None = None
    try:
        from ripple.utils.config import get_config

        config = get_config()
        executable = str(config.get("external_agents.codex.codex_executable", "codex") or "codex")
        configured_env = config.get("external_agents.codex.env", {}) or {}
        if isinstance(configured_env, dict):
            extra_env.update({str(key): str(value) for key, value in configured_env.items() if value is not None})
        configured_home = config.get("external_agents.codex.codex_home")
        if configured_home:
            path = Path(str(configured_home)).expanduser()
            path.mkdir(parents=True, exist_ok=True)
            codex_home = str(path)
            extra_env["CODEX_HOME"] = codex_home
    except Exception:  # noqa: BLE001
        pass
    return executable, extra_env, codex_home


def codex_cli_login_status() -> tuple[bool, str, dict[str, Any]]:
    """Return the real server-side Codex CLI login state used by app-server."""

    executable, extra_env, codex_home = _configured_codex_runtime()
    metadata: dict[str, Any] = {
        "auth_source": "codex_cli",
        "codex_executable": executable,
    }
    if codex_home:
        metadata["codex_home"] = codex_home
    resolved = shutil.which(executable) if not Path(executable).is_absolute() else executable
    if not resolved or not Path(resolved).exists():
        metadata["status"] = "missing_cli"
        return False, "Codex CLI is not installed or not on PATH.", metadata

    metadata["codex_path"] = resolved
    try:
        result = subprocess.run(
            [resolved, "login", "status"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env={**os.environ, **extra_env},
        )
    except subprocess.TimeoutExpired:
        metadata["status"] = "timeout"
        return False, "Codex CLI login status timed out.", metadata
    except OSError as exc:
        metadata["status"] = "status_error"
        return False, f"Codex CLI login status failed: {exc}", metadata

    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    first_line = output.splitlines()[0] if output else ""
    if first_line:
        metadata["status_output"] = first_line
    if result.returncode == 0 and "Logged in" in output:
        metadata["status"] = "logged_in"
        return True, "Codex CLI is logged in for the server user.", metadata

    metadata["status"] = "not_logged_in" if result.returncode == 0 else "status_failed"
    detail = first_line or "Codex CLI is not logged in."
    return False, detail, metadata


class CodexCliConnector(BaseConnector):
    def __init__(self):
        super().__init__(
            ConnectorInfo(
                name="openai_codex",
                display_name="OpenAI Codex",
                description="Server-side Codex CLI login used by the app-server executor.",
                auth_type="cli",
                kind="runtime_capability",
                auth_flow="none",
                auth_surfaces={"web": False, "chat": False},
            )
        )

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        connected, detail, metadata = codex_cli_login_status()
        return ConnectorStatus(
            name=self.info.name,
            connected=connected,
            required=not connected,
            detail=detail,
            metadata=metadata,
        )


class NotionConnector(BaseConnector):
    def __init__(self):
        super().__init__(
            ConnectorInfo(
                name="notion",
                display_name="Notion",
                description="Notion API access through a per-user integration token.",
                auth_type="token",
                kind="user_connector",
                auth_flow="token",
                auth_surfaces={"web": True, "chat": True},
                auth_start_path=_connector_path("notion", "auth/start"),
                disconnect_path=_connector_path("notion", "disconnect"),
            )
        )

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        connected = config.has_notion_token(user_id)
        return ConnectorStatus(
            name=self.info.name,
            connected=connected,
            required=not connected,
            detail="Notion token is stored for this user." if connected else "Notion token is missing for this user.",
        )

    async def auth_start(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
        *,
        request_base_url: str | None = None,
    ) -> ConnectorActionResult:
        api_token = str(payload.get("api_token") or payload.get("token") or "").strip()
        if not api_token:
            return ConnectorActionResult(self.info.name, False, "missing_token", "api_token is required.")
        if not (api_token.startswith("ntn_") or api_token.startswith("secret_")):
            return ConnectorActionResult(
                self.info.name,
                False,
                "invalid_token",
                "Notion token must start with `ntn_` or `secret_`.",
            )
        if len(api_token) < 20 or len(api_token) > 200:
            return ConnectorActionResult(
                self.info.name,
                False,
                "invalid_token",
                f"Notion token length is unexpected: {len(api_token)}.",
            )

        write_notion_token(config, user_id, api_token)
        write_nsjail_config(config, user_id)
        return ConnectorActionResult(
            self.info.name,
            True,
            "authorized",
            "Notion token has been stored for this user.",
            {"token_preview": _mask_secret(api_token)},
        )

    async def disconnect(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        try:
            removed = _safe_unlink(config.notion_config_file(user_id))
            write_nsjail_config(config, user_id)
        except (OSError, RuntimeError) as exc:
            return ConnectorActionResult(self.info.name, False, "disconnect_failed", str(exc))
        return ConnectorActionResult(
            self.info.name,
            True,
            "disconnected",
            "Notion token removed for this user." if removed else "No Notion token was stored.",
            {"credential_removed": removed},
        )


class FeishuConnector(BaseConnector):
    def __init__(self):
        super().__init__(
            ConnectorInfo(
                name="feishu",
                display_name="Feishu",
                description="Feishu/Lark access through browser authorization.",
                auth_type="oauth",
                kind="user_connector",
                auth_flow="oauth_device",
                auth_surfaces={"web": True, "chat": True},
                auth_start_path=_connector_path("feishu", "auth/start"),
                auth_complete_path=_connector_path("feishu", "auth/complete"),
                disconnect_path=_connector_path("feishu", "disconnect"),
            )
        )

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        connected, detail, metadata = feishu_cli_login_status(config, user_id)
        seed_file = config.feishu_config_file(user_id)
        metadata = {**metadata, "has_seed_credentials": seed_file.exists()}
        return ConnectorStatus(
            name=self.info.name,
            connected=connected,
            required=not connected,
            detail=detail,
            metadata=metadata,
        )

    async def auth_start(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
        *,
        request_base_url: str | None = None,
    ) -> ConnectorActionResult:
        app_id = str(payload.get("app_id") or "").strip()
        app_secret = str(payload.get("app_secret") or "").strip()
        brand = str(payload.get("brand") or "feishu").strip() or "feishu"
        if app_id or app_secret:
            if not app_id or not app_secret:
                return ConnectorActionResult(
                    self.info.name,
                    False,
                    "invalid_credentials",
                    "Both app_id and app_secret are required when seeding Feishu credentials.",
                )
            seed_file = config.feishu_config_file(user_id)
            seed_file.parent.mkdir(parents=True, exist_ok=True)
            seed_file.write_text(
                json.dumps({"app_id": app_id, "app_secret": app_secret, "brand": brand}, indent=2),
                encoding="utf-8",
            )
            seed_file.chmod(0o600)

        force_new_setup = _payload_bool(payload, "force_new_setup", _payload_bool(payload, "force_new", False))

        ok, msg = await ensure_lark_cli_config(config, user_id, force_new_setup=force_new_setup)
        write_nsjail_config(config, user_id)
        if msg.startswith("http://") or msg.startswith("https://"):
            return ConnectorActionResult(
                self.info.name,
                True,
                "awaiting_setup",
                "Open the setup URL to finish Feishu configuration.",
                {"setup_url": msg},
            )
        if not ok:
            return ConnectorActionResult(self.info.name, False, "auth_failed", msg)

        auth_ok, data = await start_lark_user_auth(config, user_id, force_new=True)
        if not auth_ok:
            return ConnectorActionResult(
                self.info.name,
                False,
                "auth_failed",
                str(data.get("error") or "Failed to start Feishu user authorization."),
            )
        return ConnectorActionResult(
            self.info.name,
            True,
            "awaiting_user_auth",
            "Open oauth_url in a browser, finish Feishu authorization, then complete the auth flow.",
            data,
        )

    async def auth_complete(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        device_code = str(payload.get("device_code") or "").strip()
        if not device_code:
            return ConnectorActionResult(self.info.name, False, "invalid_request", "device_code is required.")
        ok, msg = await complete_lark_user_auth(config, user_id, device_code)
        write_nsjail_config(config, user_id)
        if ok:
            return ConnectorActionResult(
                self.info.name,
                True,
                "authorized",
                "Feishu user authorization completed for this user.",
            )
        stage = "pending" if "pending" in msg.lower() or "not yet" in msg.lower() else "auth_failed"
        return ConnectorActionResult(self.info.name, stage == "pending", stage, msg)

    async def disconnect(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        removed_seed = _safe_unlink(config.feishu_config_file(user_id))
        config_dir = config.workspace_dir(user_id) / ".lark-cli"
        removed_workspace_config = False
        if config_dir.exists():
            shutil.rmtree(config_dir)
            removed_workspace_config = True
        write_nsjail_config(config, user_id)
        return ConnectorActionResult(
            self.info.name,
            True,
            "disconnected",
            "Feishu connector state removed for this user.",
            {"seed_removed": removed_seed, "workspace_config_removed": removed_workspace_config},
        )


class BilibiliConnector(BaseConnector):
    def __init__(self):
        super().__init__(
            ConnectorInfo(
                name="bilibili",
                display_name="Bilibili",
                description="Bilibili session access through QR login credentials.",
                auth_type="qr",
                kind="user_connector",
                auth_flow="qr",
                auth_surfaces={"web": True, "chat": True},
                auth_start_path=_connector_path("bilibili", "auth/start"),
                auth_complete_path=_connector_path("bilibili", "auth/complete"),
                disconnect_path=_connector_path("bilibili", "disconnect"),
            )
        )

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        credential = read_bilibili_credential(config, user_id)
        connected = credential is not None
        metadata: dict[str, Any] = {}
        if credential:
            metadata = {
                "uname": credential.get("uname") or "",
                "mid": credential.get("mid") or 0,
                "expires_at": credential.get("expires_at") or 0,
            }
        return ConnectorStatus(
            name=self.info.name,
            connected=connected,
            required=not connected,
            detail="Bilibili credentials are stored for this user."
            if connected
            else "Bilibili credentials are missing for this user.",
            metadata=metadata,
        )

    async def auth_start(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
        *,
        request_base_url: str | None = None,
    ) -> ConnectorActionResult:
        credential = read_bilibili_credential(config, user_id)
        if credential:
            return ConnectorActionResult(
                self.info.name,
                True,
                "authorized",
                "Bilibili account is already connected for this user.",
                {
                    "bound": True,
                    "uname": credential.get("uname") or "",
                    "mid": credential.get("mid") or 0,
                    "expires_at": credential.get("expires_at") or 0,
                },
            )

        try:
            generated = await asyncio.to_thread(qrcode_generate)
        except RuntimeError as exc:
            return ConnectorActionResult(self.info.name, False, "auth_failed", str(exc))

        qrcode_key = generated["qrcode_key"]
        qrcode_content = generated["qrcode_content"]
        image_url = "/v1/bilibili/qrcode.png?content=" + urllib.parse.quote(qrcode_content, safe="")
        acquire_gate(user_id, qrcode_key)
        return ConnectorActionResult(
            self.info.name,
            True,
            "awaiting_user",
            "Open qrcode_image_url with the Bilibili app, then complete the auth flow.",
            {
                "bound": False,
                "qrcode_key": qrcode_key,
                "qrcode_image_url": image_url,
                "qrcode_content": qrcode_content,
                "expires_in_seconds": QRCODE_TTL_SECONDS,
            },
        )

    async def auth_complete(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        qrcode_key = str(payload.get("qrcode_key") or "").strip()
        if not qrcode_key:
            return ConnectorActionResult(self.info.name, False, "invalid_request", "qrcode_key is required.")
        max_wait = int(payload.get("max_wait_seconds") or 30)
        max_wait = max(5, min(max_wait, 300))
        deadline = time.monotonic() + max_wait
        last_state = "waiting_scan"
        release_reason: str | None = None
        try:
            while time.monotonic() < deadline:
                try:
                    result = await asyncio.to_thread(qrcode_poll, qrcode_key)
                except RuntimeError as exc:
                    logger.warning("user {} Bilibili QR poll failed: {}", user_id, exc)
                    await asyncio.sleep(2)
                    continue
                last_state = result.get("state", "unknown")
                if last_state == "expired":
                    release_reason = "poll_expired"
                    return ConnectorActionResult(
                        self.info.name,
                        True,
                        "expired",
                        "Bilibili QR code expired.",
                        {"raw_code": result.get("raw_code")},
                    )
                if last_state == "ok":
                    fields = result.get("credential_fields") or {}
                    sessdata = fields.get("sessdata") or ""
                    if not sessdata:
                        release_reason = "missing_sessdata"
                        return ConnectorActionResult(
                            self.info.name,
                            False,
                            "auth_failed",
                            "Bilibili returned success without SESSDATA.",
                        )
                    live = await asyncio.to_thread(verify_credential_live, sessdata)
                    now = int(time.time())
                    credential = {
                        **fields,
                        "bound_at": now,
                        "uname": live.get("uname") or "",
                        "mid": live.get("mid") or 0,
                    }
                    write_bilibili_credential(config, user_id, credential)
                    write_nsjail_config(config, user_id)
                    release_reason = "authorized"
                    return ConnectorActionResult(
                        self.info.name,
                        True,
                        "authorized",
                        "Bilibili credentials stored for this user.",
                        {
                            "uname": credential["uname"],
                            "mid": credential["mid"],
                            "expires_at": credential.get("expires_at") or 0,
                        },
                    )
                await asyncio.sleep(2)
            stage = "timeout" if max_wait >= 90 else "pending"
            if stage == "timeout":
                release_reason = "poll_timeout"
            return ConnectorActionResult(
                self.info.name,
                True,
                stage,
                "Bilibili QR scan is still pending." if stage == "pending" else "Bilibili QR poll timed out.",
                {"last_state": last_state, "waited_seconds": max_wait},
            )
        finally:
            if release_reason:
                release_gate(user_id, release_reason)

    async def disconnect(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        gate_was_held = release_gate(user_id, "disconnect")
        removed = clear_bilibili_credential(config, user_id)
        write_nsjail_config(config, user_id)
        return ConnectorActionResult(
            self.info.name,
            True,
            "disconnected",
            "Bilibili credentials removed for this user." if removed else "No Bilibili credentials were stored.",
            {"credential_removed": removed, "pending_scan_cancelled": gate_was_held},
        )


class GoogleWorkspaceConnector(BaseConnector):
    def __init__(self):
        super().__init__(
            ConnectorInfo(
                name="google_workspace",
                display_name="Google Workspace",
                description="Gmail, Drive, Docs, Sheets, Slides, and Calendar through gogcli.",
                auth_type="oauth",
                kind="user_connector",
                auth_flow="oauth_assisted",
                auth_surfaces={"web": True, "chat": True},
                auth_start_path=_connector_path("google_workspace", "auth/start"),
                auth_complete_path=_connector_path("google_workspace", "auth/complete"),
                disconnect_path=_connector_path("google_workspace", "disconnect"),
                accounts_path=_connector_path("google_workspace", "accounts"),
            )
        )

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        connected = config.has_gogcli_login(user_id)
        return ConnectorStatus(
            name=self.info.name,
            connected=connected,
            required=not connected,
            detail="Google Workspace account is connected for this user."
            if connected
            else "Google Workspace is not connected for this user.",
            metadata={"has_client_config": config.has_gogcli_client_config(user_id)},
        )

    async def auth_start(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
        *,
        request_base_url: str | None = None,
    ) -> ConnectorActionResult:
        email = str(payload.get("email") or "").strip()
        if not email or "@" not in email:
            return ConnectorActionResult(self.info.name, False, "invalid_request", "email is required.")
        if not config.gogcli_cli_install_root:
            return ConnectorActionResult(
                self.info.name,
                False,
                "missing_cli",
                "gogcli is not installed. Ask an administrator to run scripts/install-gogcli-cli.sh.",
            )

        assisted_callback_url = resolve_gogcli_oauth_callback_url(request_base_url=request_base_url)
        if not config.has_gogcli_client_config(user_id):
            try:
                configured_client = configured_gogcli_client_secret_json(callback_url=assisted_callback_url)
            except (ValueError, TypeError) as exc:
                return ConnectorActionResult(self.info.name, False, "server_config_invalid", str(exc))
            if configured_client:
                try:
                    await register_gogcli_client_config(config, user_id, configured_client)
                except (ValueError, GogcliClientRegistrationError, OSError) as exc:
                    return ConnectorActionResult(self.info.name, False, "server_config_failed", str(exc))
            else:
                callback_hint = assisted_callback_url or "<server.public_base_url>/v1/sandboxes/gogcli/oauth/callback"
                return ConnectorActionResult(
                    self.info.name,
                    False,
                    "server_config_required",
                    (
                        "Google Workspace OAuth client is not configured. Configure "
                        f"server.gogcli_oauth.client and allow redirect URI: {callback_hint}"
                    ),
                )

        ensure_gogcli_keyring_password(config, user_id)
        write_nsjail_config(config, user_id)
        cmd = (
            f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(email)} --services {GOGCLI_BASIC_SERVICES_ARG} --remote --step 1"
        )
        if assisted_callback_url:
            cmd += f" --redirect-uri {_shq(assisted_callback_url)}"
        stdout, stderr, code = await execute_in_sandbox(cmd, config, user_id, timeout=20)
        if code != 0:
            return ConnectorActionResult(
                self.info.name,
                False,
                "auth_failed",
                f"gog auth add step 1 failed (exit {code}): {stderr[-500:] or stdout[-500:]}",
            )

        match = _GOOGLE_OAUTH_URL_RE.search(stdout + "\n" + stderr)
        if not match:
            return ConnectorActionResult(self.info.name, False, "auth_failed", "Could not find Google OAuth URL.")
        oauth_url = match.group(0).rstrip(".,;)")
        callback_mode = "manual"
        stage = "awaiting_user_callback_url"
        data: dict[str, Any] = {
            "oauth_url": oauth_url,
            "email": email,
            "expires_in_seconds": 600,
            "callback_mode": callback_mode,
        }
        if assisted_callback_url:
            state = extract_oauth_state(oauth_url)
            if state:
                register_pending_gogcli_oauth(
                    state=state,
                    user_id=user_id,
                    email=email,
                    redirect_uri=assisted_callback_url,
                )
                callback_mode = "assisted"
                stage = "awaiting_browser_callback"
                data["callback_mode"] = callback_mode
                data["assisted_callback_url"] = assisted_callback_url
        return ConnectorActionResult(self.info.name, True, stage, "Open oauth_url to continue.", data)

    async def auth_complete(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        email = str(payload.get("email") or "").strip()
        callback_url = str(payload.get("callback_url") or "").strip()
        if not _GOOGLE_EMAIL_RE.match(email):
            return ConnectorActionResult(self.info.name, False, "invalid_request", "email is invalid.")
        if not _looks_like_google_callback_url(callback_url):
            return ConnectorActionResult(self.info.name, False, "invalid_request", "callback_url is invalid.")
        if "code=" not in callback_url or "state=" not in callback_url:
            return ConnectorActionResult(
                self.info.name, False, "invalid_request", "callback_url must include code and state."
            )

        ensure_gogcli_keyring_password(config, user_id)
        write_nsjail_config(config, user_id)
        cmd = (
            f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(email)} "
            f"--services {GOGCLI_BASIC_SERVICES_ARG} --remote --step 2 --auth-url {_shq(callback_url)}"
        )
        stdout, stderr, code = await execute_in_sandbox(cmd, config, user_id, timeout=60)
        if code != 0:
            return ConnectorActionResult(
                self.info.name,
                False,
                "auth_failed",
                f"gog auth add step 2 failed (exit {code}): {stderr[-500:] or stdout[-500:]}",
            )
        return ConnectorActionResult(
            self.info.name,
            True,
            "authorized",
            "Google Workspace account authorized for this user.",
            {"email": email},
        )

    async def disconnect(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult:
        email = str(payload.get("email") or "").strip()
        if not _GOOGLE_EMAIL_RE.match(email):
            return ConnectorActionResult(self.info.name, False, "invalid_request", "email is required.")
        if not config.gogcli_cli_install_root:
            return ConnectorActionResult(self.info.name, False, "missing_cli", "gogcli is not installed.")
        ensure_gogcli_keyring_password(config, user_id)
        write_nsjail_config(config, user_id)
        stdout, stderr, code = await execute_in_sandbox(
            f"{GOGCLI_CLI_SANDBOX_BIN} auth remove {_shq(email)} --force",
            config,
            user_id,
            timeout=15,
        )
        if code != 0:
            return ConnectorActionResult(
                self.info.name,
                False,
                "disconnect_failed",
                f"gog auth remove failed (exit {code}): {stderr[-500:] or stdout[-500:]}",
            )
        accounts = await self.accounts(config, user_id, check=False)
        return ConnectorActionResult(
            self.info.name,
            True,
            "disconnected",
            "Google Workspace account removed from this user's keyring.",
            {"email": email, "remaining_accounts": accounts["count"]},
        )

    async def accounts(self, config: SandboxConfig, user_id: str, *, check: bool = False) -> dict[str, Any]:
        if not config.gogcli_cli_install_root:
            return {"has_client_config": False, "accounts": [], "count": 0, "checked": check}
        has_client = config.has_gogcli_client_config(user_id)
        cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
        if check:
            cmd += " --check"
        stdout, _stderr, code = await execute_in_sandbox(cmd, config, user_id, timeout=30 if check else 10)
        if code != 0:
            return {"has_client_config": has_client, "accounts": [], "count": 0, "checked": check}
        try:
            raw = parse_auth_list_output(stdout)
        except ValueError:
            return {"has_client_config": has_client, "accounts": [], "count": 0, "checked": check}
        return {"has_client_config": has_client, "accounts": raw, "count": len(raw), "checked": check}


class RuntimeCapabilityConnector(BaseConnector):
    def __init__(self, *, name: str, display_name: str, description: str, metadata: dict[str, Any] | None = None):
        super().__init__(
            ConnectorInfo(
                name=name,
                display_name=display_name,
                description=description,
                auth_type="runtime",
                kind="runtime_capability",
                auth_flow="none",
                auth_surfaces={"web": False, "chat": False},
            )
        )
        self._metadata = metadata or {}

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus:
        return ConnectorStatus(
            name=self.info.name,
            connected=True,
            required=False,
            detail=f"{self.info.display_name} is provided by the server-side Codex runtime.",
            metadata={"auth_source": "codex_runtime", **self._metadata},
        )


def _looks_like_google_callback_url(callback_url: str) -> bool:
    if not _GOOGLE_CALLBACK_URL_RE.match(callback_url):
        return False
    try:
        parsed = urlparse(callback_url)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and bool(parsed.path)


def _builtins() -> list[BaseConnector]:
    return [
        GoogleWorkspaceConnector(),
        NotionConnector(),
        FeishuConnector(),
        BilibiliConnector(),
        CodexCliConnector(),
        RuntimeCapabilityConnector(
            name="codex_image_generation",
            display_name="Image Generation",
            description="Generate images through the server-side Codex runtime without per-user third-party auth.",
        ),
        RuntimeCapabilityConnector(
            name="codex_image_input",
            display_name="Image Input",
            description="Accept and inspect uploaded or remote images through Codex native input items.",
        ),
        RuntimeCapabilityConnector(
            name="codex_web_search",
            display_name="Web Search",
            description="Use Codex runtime web/search capabilities when available to the service account.",
        ),
    ]


_CONNECTORS = {connector.info.name: connector for connector in _builtins()}


def list_connectors() -> list[BaseConnector]:
    return list(_CONNECTORS.values())


def get_connector(name: str) -> BaseConnector | None:
    return _CONNECTORS.get(name)
