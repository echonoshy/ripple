"""GoogleWorkspaceLoginComplete — 跑 `gog auth add --remote --step 2`，完成 OAuth 绑定

两步流程的**第 2 步**。前置：用户已在浏览器点 Allow 并把地址栏回调 URL 贴回对话。

流程：
  1. agent 从用户输入里拿到形如
     `http://127.0.0.1:<port>/oauth2/callback?code=...&state=...` 的 URL。
  2. 本工具在沙箱里跑 `gog auth add <email> --services user --remote --step 2 --auth-url '<url>'`。
  3. gog 内部校验 state、用 code 换 token、加密存 refresh_token 到 keyring。
  4. 工具返回 ok=true，agent 业务继续。

风险等级：SAFE（一条短命令；gogcli 自己做 state 校验）。
"""

import re
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import ensure_gogcli_keyring_password
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_login_complete")

_CALLBACK_URL_PATTERN = re.compile(r"^https?://[^/]+/oauth2/callback\?[^\s]+$")


def _shq(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


class GoogleWorkspaceLoginCompleteTool(Tool):
    """用用户回贴的 callback URL 完成 OAuth（step 2）"""

    def __init__(self):
        self.name = "GoogleWorkspaceLoginComplete"
        self.description = (
            "Finish step 2 of the gogcli OAuth remote flow using the callback URL the user "
            "pasted back. Requires `GoogleWorkspaceLoginStart` to have been called recently "
            "(within ~10 min; state expires after that).\n\n"
            "Parameters:\n"
            "- email (required): Same email passed to `GoogleWorkspaceLoginStart`.\n"
            "- callback_url (required): The full URL from the user's browser address bar, should "
            "  look like `http://127.0.0.1:<port>/oauth2/callback?code=...&state=...`.\n\n"
            "IMPORTANT:\n"
            "- Pass the `callback_url` exactly as the user pasted (do NOT shorten or strip params).\n"
            "- If you get 'state expired' / 'state mismatch' error, call `GoogleWorkspaceLoginStart` "
            "  again to restart the flow.\n"
            "- If you get 'access_denied' error, user declined / picked wrong account / "
            "  not added to OAuth consent Test users.\n\n"
            "After success, subsequent `Bash(command='gog <service> ...')` calls will work "
            "immediately; no other setup needed. Encrypted refresh token is stored in "
            "`/workspace/.config/gogcli/keyring/` inside the sandbox."
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
                            "description": "The email passed to GoogleWorkspaceLoginStart.",
                        },
                        "callback_url": {
                            "type": "string",
                            "description": (
                                "The full URL from the user's browser address bar after clicking Allow. "
                                "Shape: http://127.0.0.1:<port>/oauth2/callback?code=...&state=..."
                            ),
                        },
                    },
                    "required": ["email", "callback_url"],
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        email = (args.get("email") or "").strip()
        callback_url = (args.get("callback_url") or "").strip()

        if not email or "@" not in email:
            return ToolResult(data={"ok": False, "error": "email 参数无效"})
        if not _CALLBACK_URL_PATTERN.match(callback_url):
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "callback_url 格式不符。期望形如 "
                        "http://127.0.0.1:<port>/oauth2/callback?code=...&state=...\n"
                        f"实际收到: {callback_url[:200]}"
                    ),
                }
            )
        if "code=" not in callback_url or "state=" not in callback_url:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "callback_url 缺少 code 或 state 参数。请让用户重新从浏览器地址栏完整复制。",
                }
            )

        ensure_gogcli_keyring_password(_sandbox_config, user_id)
        write_nsjail_config(_sandbox_config, user_id)
        cmd = (
            f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(email)} "
            f"--services user --remote --step 2 --auth-url {_shq(callback_url)}"
        )
        stdout, stderr, code = await execute_in_sandbox(cmd, _sandbox_config, user_id, timeout=60)

        if code != 0:
            logger.warning("user {} gog auth add step 2 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"gog auth add step 2 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}\n"
                        "常见原因：1) state 过期（>10 分钟）—— 请让用户重新从 GoogleWorkspaceLoginStart 开始；"
                        "2) access_denied —— 用户没在 OAuth consent screen Test users 列表里；"
                        "3) URL 不完整 —— 让用户从浏览器地址栏**原封不动**完整复制。"
                    ),
                }
            )

        verify_cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth status"
        vout, verr, vcode = await execute_in_sandbox(verify_cmd, _sandbox_config, user_id, timeout=15)

        logger.info("user {} gogcli 绑定成功: {}", user_id, email)

        return ToolResult(
            data={
                "ok": True,
                "stage": "authorized",
                "email": email,
                "auth_status_exit_code": vcode,
                "auth_status_stdout_tail": (vout + verr)[-500:],
                "next": (
                    f"授权完成。可以直接跑 gog 业务命令了，例如 "
                    f"`Bash(command='gog --account {email} --json gmail search \"newer_than:7d\" --max 5')`。"
                    "对于破坏性写操作（gmail send / drive delete / etc），执行前必须先调 AskUser "
                    "工具复述完整意图请用户确认。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
