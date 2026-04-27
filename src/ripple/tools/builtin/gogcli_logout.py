"""GoogleWorkspaceLogout — 解绑当前 user 的某个 Google 账号

调用场景：
  * 用户说"解绑 alice@ 换成 bob@"
  * refresh_token 被 Google 侧 revoke（用户在 Google 账户里撤销了权限），
    本地 keyring 里的条目变成僵尸，要清一下再重走 LoginStart
  * 用户不再使用 ripple 的 gogcli 能力，想清理授权

行为：
  * 跑 `gog auth remove <email> --force`
  * 不删 Desktop OAuth client config（那是跨账号共享的）
  * 跑 `gog auth list --json` 把剩余账号数报给 agent

风险等级：SAFE（只影响本地 keyring 一个条目；Google 侧 refresh_token 仍在，
  除非用户主动 revoke；要彻底清理 agent 可引导用户去 Google 账户设置里 revoke）。
  写操作前的 AskUser 由 skill 层负责（见 gog-shared/SKILL.md 破坏性清单）。
"""

import re
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import ensure_gogcli_keyring_password, parse_auth_list_output
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_logout")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _shq(s: str) -> str:
    """POSIX shell 单引号转义。"""
    return "'" + s.replace("'", "'\\''") + "'"


class GoogleWorkspaceLogoutTool(Tool):
    """解绑当前 user 的某个 Google 账号（从本地 keyring 移除 refresh_token）"""

    def __init__(self):
        self.name = "GoogleWorkspaceLogout"
        self.description = (
            "Unbind a Google account from the current user's gogcli keyring (removes the "
            "refresh token locally; does NOT revoke on Google's side).\n\n"
            "Parameters:\n"
            "- email (required): The Google account to remove, e.g. alice@gmail.com.\n\n"
            "Before calling this tool:\n"
            "- **You MUST call AskUser first** to confirm with the user which account and why. "
            "  This is a destructive action on local state (covered in gog-shared/SKILL.md).\n"
            "- If the user wants to revoke Google-side access too, guide them to "
            "  https://myaccount.google.com/permissions — this tool does not revoke server-side.\n\n"
            "Returns:\n"
            "  {ok: true, email, remaining_accounts: int | null}\n"
            "  remaining_accounts is null if the post-op `gog auth list` failed "
            "  (the logout itself still succeeded).\n\n"
            "Does NOT touch the Desktop OAuth client config "
            "(`GoogleWorkspaceClientConfigSet`'s state); that stays bound for future accounts."
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
                        "email": {
                            "type": "string",
                            "description": "The Google account email to unbind, e.g. alice@gmail.com.",
                        }
                    },
                    "required": ["email"],
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

        email = (args.get("email") or "").strip()
        if not email:
            return ToolResult(data={"ok": False, "error": "email 参数为空"})
        if not _EMAIL_RE.match(email):
            return ToolResult(data={"ok": False, "error": f"email 格式不合法: {email}"})

        ensure_gogcli_keyring_password(_sandbox_config, user_id)
        write_nsjail_config(_sandbox_config, user_id)
        remove_cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth remove {_shq(email)} --force"
        stdout, stderr, code = await execute_in_sandbox(remove_cmd, _sandbox_config, user_id, timeout=15)
        if code != 0:
            logger.warning("user {} gog auth remove {} 失败 (code={}): {}", user_id, email, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"gog auth remove 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}。"
                        "常见原因：1) 该 email 并未绑定；2) keyring 锁竞争；3) gog 版本不兼容。"
                    ),
                }
            )

        remaining: int | None
        list_cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
        lout, lerr, lcode = await execute_in_sandbox(list_cmd, _sandbox_config, user_id, timeout=10)
        if lcode == 0:
            try:
                remaining = len(parse_auth_list_output(lout))
            except ValueError:
                logger.warning("user {} 解析 gog auth list 输出失败，remaining_accounts 设为 None", user_id)
                remaining = None
        else:
            logger.warning("user {} gog auth list 验证失败 (code={}): {}", user_id, lcode, lerr[:500])
            remaining = None

        logger.info("user {} 已解绑 gogcli 账号 {} (剩余 {})", user_id, email, remaining)
        return ToolResult(
            data={
                "ok": True,
                "email": email,
                "remaining_accounts": remaining,
                "next": (
                    f"账号 {email} 已从本地 keyring 移除。**Google 侧的授权本身并未撤销**——"
                    "如用户想彻底清理，引导他去 https://myaccount.google.com/permissions 手动 revoke。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
