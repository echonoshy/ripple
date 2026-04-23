"""gogcli (`gog`) 的 per-user 凭证/密码管理

本模块承担两件事：
  1. **OAuth Desktop client_secret.json 的读/写**：用户在对话里贴 JSON，
     `GoogleWorkspaceClientConfigSet` 工具调 `write_gogcli_client_config` 落到
     `sandboxes/<uid>/credentials/gogcli-client.json`，沙箱启动时
     `read_gogcli_client_config` 读出来注入 env（`GOG_CLIENT_ID` /
     `GOG_CLIENT_SECRET` 只是内部名，实际传给 `gog auth credentials` 子命令的
     时候走 stdin / tempfile；见 `gogcli_client_config_set` 工具）。
  2. **keyring backend=file 的加密密码**：ripple 在 user 首次 provision 时
     随机生成 32B 密码落到 `sandboxes/<uid>/credentials/gogcli-keyring.pass`
     (mode 0600)，沙箱启动时作为 env `GOG_KEYRING_PASSWORD` 注入。密码对
     agent / user 都不可见。

**不**持有 OAuth refresh token —— refresh token 由 gogcli 自己管，加密写到
`/workspace/.config/gogcli/keyring/`（随 workspace 一起 per-user 隔离）。
"""

import json
import secrets
from typing import NamedTuple

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.gogcli")


class GogcliClientConfig(NamedTuple):
    """从 client_secret.json 解析出的最小字段集。"""

    client_id: str
    client_secret: str


def _extract_bucket(data: dict) -> dict | None:
    """从 client_secret.json 结构里取出含 client_id 的 dict。

    支持:
      - {"installed": {...}}（Desktop OAuth Client，gogcli 推荐）
      - {"web": {...}}（Web OAuth Client，兜底）
      - 顶层扁平结构（罕见）
    """
    for key in ("installed", "web"):
        candidate = data.get(key)
        if isinstance(candidate, dict) and candidate.get("client_id"):
            return candidate
    if data.get("client_id"):
        return data
    return None


def read_gogcli_client_config(config: SandboxConfig, user_id: str) -> GogcliClientConfig | None:
    """读取 user 级 gogcli-client.json，返回 (client_id, client_secret)。

    返回 None 表示文件不存在 / 不是合法 JSON / 字段缺失。调用方（`nsjail_config`）
    在 None 时跳过相关 env 注入；沙箱命令执行时 gogcli 会因缺少 client 而报错，
    agent 应据此引导用户调 `GoogleWorkspaceClientConfigSet`。
    """
    f = config.gogcli_client_config_file(user_id)
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("user {} gogcli-client.json 读取失败: {}", user_id, e)
        return None

    if not isinstance(data, dict):
        logger.warning("user {} gogcli-client.json 不是 JSON 对象", user_id)
        return None

    bucket = _extract_bucket(data)
    if bucket is None:
        logger.warning("user {} gogcli-client.json 里找不到 client_id 字段", user_id)
        return None

    client_id = bucket.get("client_id")
    client_secret = bucket.get("client_secret")
    if not isinstance(client_id, str) or not client_id.strip():
        logger.warning("user {} gogcli-client.json 的 client_id 无效", user_id)
        return None
    if not isinstance(client_secret, str) or not client_secret.strip():
        logger.warning("user {} gogcli-client.json 的 client_secret 无效", user_id)
        return None

    return GogcliClientConfig(client_id=client_id.strip(), client_secret=client_secret.strip())


def write_gogcli_client_config(config: SandboxConfig, user_id: str, client_secret_raw: str) -> GogcliClientConfig:
    """把 client_secret.json 原文落盘到 sandbox_dir/credentials/gogcli-client.json。

    调用方（`GoogleWorkspaceClientConfigSet` 工具）职责：校验 user_id、确保
    sandbox_dir 存在。本函数职责：解析 JSON、校验字段、原子落盘 0600、
    返回字段摘要（不含 secret 回显）。
    """
    try:
        parsed = json.loads(client_secret_raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"client_secret.json 不是合法 JSON: {e.msg} @ line {e.lineno} col {e.colno}") from e

    if not isinstance(parsed, dict) or not parsed:
        raise ValueError("client_secret.json 不是非空 JSON 对象")

    bucket = _extract_bucket(parsed)
    if bucket is None:
        raise ValueError(
            "client_secret.json 里找不到 client_id 字段（期望结构: "
            '{"installed": {"client_id": "...", "client_secret": "..."}} 或 web 变种）'
        )

    client_id = bucket.get("client_id")
    client_secret = bucket.get("client_secret")
    if not isinstance(client_id, str) or not client_id.strip():
        raise ValueError("client_secret.json 的 client_id 字段无效")
    if not isinstance(client_secret, str) or not client_secret.strip():
        raise ValueError("client_secret.json 的 client_secret 字段无效")

    f = config.gogcli_client_config_file(user_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(parsed, indent=2, ensure_ascii=False)
    f.write_text(payload, encoding="utf-8")
    f.chmod(0o600)
    logger.debug("写入 user {} gogcli-client.json (client_id={}...)", user_id, client_id[:12])
    return GogcliClientConfig(client_id=client_id.strip(), client_secret=client_secret.strip())


def ensure_gogcli_keyring_password(config: SandboxConfig, user_id: str) -> str:
    """幂等地拿到 user 级 gogcli keyring 密码；不存在则生成 32B 随机密码并落盘。

    密码用于 `GOG_KEYRING_BACKEND=file` 时加密 refresh_token。密码本身仅
    ripple 进程可读（mode 0600），agent/user 都不会见到。

    返回：密码字符串（已 strip）。
    """
    f = config.gogcli_keyring_pass_file(user_id)
    if f.exists():
        try:
            pw = f.read_text(encoding="utf-8").strip()
            if pw:
                return pw
        except OSError as e:
            logger.warning("user {} gogcli-keyring.pass 读取失败 ({}), 将重新生成", user_id, e)

    pw = secrets.token_urlsafe(32)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(pw, encoding="utf-8")
    f.chmod(0o600)
    logger.info("user {} gogcli keyring password 已生成", user_id)
    return pw


def parse_auth_list_output(stdout: str) -> list[dict]:
    """把 `gog auth list --json` 的输出解析成 [{email, alias, valid}] 列表。

    对格式抖动宽容：
      * 顶层可能是 `{"accounts": [...]}` 或裸数组 `[...]`
      * 每个 entry 可能缺 `alias` / `valid`，补 None
      * `valid` 可能是 bool 或 "true"/"false" 字符串

    缺 `email` 字段的 entry 会被静默丢弃（那是 gog 内部状态项，非账号）。

    Raises:
        ValueError: stdout 不是合法 JSON。调用方自己决定是报错还是降级。
    """
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"gog auth list 输出不是合法 JSON: {e.msg}") from e

    if isinstance(data, dict):
        raw_list = data.get("accounts", [])
    elif isinstance(data, list):
        raw_list = data
    else:
        return []

    out: list[dict] = []
    for entry in raw_list:
        if not isinstance(entry, dict):
            continue
        email = entry.get("email")
        if not isinstance(email, str) or not email.strip():
            continue

        alias = entry.get("alias")
        if alias is not None and not isinstance(alias, str):
            alias = None

        valid_raw = entry.get("valid")
        valid: bool | None
        if isinstance(valid_raw, bool):
            valid = valid_raw
        elif isinstance(valid_raw, str):
            low = valid_raw.strip().lower()
            if low == "true":
                valid = True
            elif low == "false":
                valid = False
            else:
                valid = None
        else:
            valid = None

        out.append({"email": email.strip(), "alias": alias, "valid": valid})
    return out
