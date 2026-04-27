"""GoogleWorkspaceAuthStatus — 列出当前 user 已绑的 Google 账号 + 可选验活

典型调用场景：
  * agent 开局不确定当前 user 绑了哪个 Google 账号，先调一次本工具再决定 --account=
  * 业务命令报 `invalid_grant` / `unauthorized_client` 之类可疑 token 问题时，
    调 `check=True` 真验一下，确认是 refresh_token 失效再引导用户重走 LoginStart
  * 前端通过 `GET /v1/sandboxes/gogcli-accounts` 展示账号列表（共享同一 helper）

默认 `check=False`——只列本地 keyring 里已绑条目，不打 Google 的 token endpoint；
`check=True` 会为每个账号调一次 refresh token exchange（有网络成本和 quota 消耗），
仅在确需验活时用。

风险等级：SAFE（只读 + 最多一次 token refresh）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import parse_auth_list_output
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_auth_status")


class GoogleWorkspaceAuthStatusTool(Tool):
    """列出当前 user 在 gogcli 里已绑的 Google 账号"""

    def __init__(self):
        self.name = "GoogleWorkspaceAuthStatus"
        self.description = (
            "List Google Workspace accounts bound to the current user in gogcli's keyring. "
            "Use this at the start of a session when you're not sure which account to target, "
            "or when an earlier gog command returned `invalid_grant`/`unauthorized_client` "
            "to confirm whether the refresh token is still valid.\n\n"
            "Parameters:\n"
            "- check (bool, optional, default=False): When true, verifies each account by "
            "  exchanging its refresh token for an access token. This costs one network "
            "  roundtrip and a tiny bit of quota per account. Default false just lists "
            "  what's stored locally.\n\n"
            "Returns:\n"
            "  {\n"
            "    ok: true,\n"
            "    has_client_config: bool,  // whether GoogleWorkspaceClientConfigSet was called\n"
            "    accounts: [{email, alias, valid}],  // valid only meaningful when check=true\n"
            "    count: int,\n"
            "    checked: bool,  // echoes the check input\n"
            "  }\n\n"
            "If `has_client_config=false`, the user hasn't bound a Desktop OAuth client yet — "
            "guide them through `GoogleWorkspaceClientConfigSet`. If `accounts=[]` but "
            "`has_client_config=true`, they need to call `GoogleWorkspaceLoginStart` for the "
            "account they want.\n"
        )
        self.risk_level = ToolRiskLevel.SAFE

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "check": {
                            "type": "boolean",
                            "description": (
                                "If true, verify each refresh token by exchanging it for an "
                                "access token. Costs one network roundtrip per account. Default false."
                            ),
                            "default": False,
                        }
                    },
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        from ripple.tools.builtin.bash import _sandbox_config  # noqa: PLC0415

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={"ok": False, "error": "gogcli 未预装。请联系管理员执行: bash scripts/install-gogcli-cli.sh"}
            )

        check = bool(args.get("check", False))
        pass_file = _sandbox_config.gogcli_keyring_pass_file(user_id)
        if not pass_file.exists():
            return ToolResult(
                data={
                    "ok": True,
                    "has_client_config": _sandbox_config.has_gogcli_client_config(user_id),
                    "accounts": [],
                    "count": 0,
                    "checked": check,
                }
            )

        cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
        if check:
            cmd += " --check"

        write_nsjail_config(_sandbox_config, user_id)
        stdout, stderr, code = await execute_in_sandbox(cmd, _sandbox_config, user_id, timeout=30 if check else 10)

        if code != 0:
            logger.warning("user {} gog auth list 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"gog auth list 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}",
                }
            )

        try:
            accounts = parse_auth_list_output(stdout)
        except ValueError as e:
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"无法解析 gog auth list 输出: {e}。stdout 片段: {stdout[:200]}",
                }
            )

        return ToolResult(
            data={
                "ok": True,
                "has_client_config": _sandbox_config.has_gogcli_client_config(user_id),
                "accounts": accounts,
                "count": len(accounts),
                "checked": check,
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return True
