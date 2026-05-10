"""Register gogcli OAuth client credentials for a user sandbox."""

from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN, SandboxConfig
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import GogcliClientConfig, ensure_gogcli_keyring_password, write_gogcli_client_config
from ripple.sandbox.nsjail_config import write_nsjail_config

_SANDBOX_CLIENT_JSON_DST = "/workspace/.config/gogcli/.pending-client.json"


class GogcliClientRegistrationError(RuntimeError):
    """Raised when `gog auth credentials` rejects the configured OAuth client."""


async def register_gogcli_client_config(
    config: SandboxConfig,
    user_id: str,
    client_secret_raw: str,
) -> GogcliClientConfig:
    """Write client_secret.json and register it with gogcli's config directory."""
    client_json_path_host = config.gogcli_client_config_file(user_id)
    previous_client_json: str | None = None
    if client_json_path_host.exists():
        previous_client_json = client_json_path_host.read_text(encoding="utf-8")

    client = write_gogcli_client_config(config, user_id, client_secret_raw)
    ensure_gogcli_keyring_password(config, user_id)
    write_nsjail_config(config, user_id)

    pending_on_workspace = config.workspace_dir(user_id) / ".config" / "gogcli" / ".pending-client.json"
    pending_on_workspace.parent.mkdir(parents=True, exist_ok=True)
    pending_on_workspace.write_text(client_json_path_host.read_text(encoding="utf-8"), encoding="utf-8")
    pending_on_workspace.chmod(0o600)

    register_cmd = (
        f"mkdir -p $XDG_CONFIG_HOME/gogcli && "
        f"{GOGCLI_CLI_SANDBOX_BIN} auth credentials {_SANDBOX_CLIENT_JSON_DST} && "
        f"rm -f {_SANDBOX_CLIENT_JSON_DST}"
    )
    stdout, stderr, code = await execute_in_sandbox(register_cmd, config, user_id, timeout=30)
    pending_on_workspace.unlink(missing_ok=True)
    if code != 0:
        if previous_client_json is None:
            client_json_path_host.unlink(missing_ok=True)
        else:
            client_json_path_host.write_text(previous_client_json, encoding="utf-8")
            client_json_path_host.chmod(0o600)
        detail = stderr[-500:] or stdout[-500:] or "unknown error"
        raise GogcliClientRegistrationError(f"gog auth credentials 失败 (exit {code}): {detail}")

    return client
