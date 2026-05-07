"""GoogleWorkspaceLoginStart — 在沙箱内跑 `gog auth add --remote --step 1`，返回 OAuth URL

两步流程的**第 1 步**。前置条件：已调 `GoogleWorkspaceClientConfigSet`。

流程：
  1. 本工具在沙箱里跑 `gog auth add <email> --services user --remote --step 1`。
  2. gog 打印一条 `https://accounts.google.com/o/oauth2/...` URL（state 缓存在沙箱磁盘）。
  3. 若能解析出浏览器可访问的 Ripple callback URL，则传给 gogcli；否则使用 gogcli
     默认的 127.0.0.1 loopback remote 流程。
  4. 返回 URL 给 agent，agent 转发给用户。
  5. assisted 模式下，Google 回调直接打回 Ripple 后端并自动完成 step 2；manual 模式下，
     用户把地址栏 URL 复制粘贴回 agent，再调 `GoogleWorkspaceLoginComplete`。

关键特性 vs gws 老方案：
  * **不**依赖 ripple server 与用户浏览器同机。
  * state 由 gog 磁盘缓存，TTL ~10 分钟，超时需要重跑本工具。

风险等级：SAFE（只跑一次短命令 + 磁盘状态）。
"""

import asyncio
import re
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import ensure_gogcli_keyring_password
from ripple.sandbox.gogcli_oauth import (
    extract_oauth_state,
    register_pending_gogcli_oauth,
    resolve_gogcli_oauth_callback_url,
)
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_login_start")

_OAUTH_URL_PATTERN = re.compile(r"https://accounts\.google\.com/o/oauth2/[^\s]+")


def _shq(s: str) -> str:
    """POSIX shell 单引号转义。"""
    return "'" + s.replace("'", "'\\''") + "'"


class GoogleWorkspaceLoginStartTool(Tool):
    """跑 `gog auth add --remote --step 1` 拿 OAuth URL"""

    def __init__(self):
        self.name = "GoogleWorkspaceLoginStart"
        self.description = (
            "Start step 1 of the gogcli OAuth remote flow. Requires "
            "`GoogleWorkspaceClientConfigSet` to have been called first.\n\n"
            "Parameters:\n"
            "- email (required): The Google account the user wants to bind "
            "  (e.g. you@gmail.com or you@company.com).\n\n"
            "What this tool does:\n"
            "  1. Runs `gog auth add <email> --services user --remote --step 1` inside the sandbox.\n"
            "  2. Captures the printed OAuth URL (gogcli caches `state` on disk, TTL ~10 min).\n"
            "  3. If Ripple can resolve a browser-reachable callback URL from config or the current "
            "API request origin, uses it so the browser callback can complete step 2 automatically.\n"
            "  4. Otherwise falls back to the fully remote manual flow where the user pastes the "
            "browser address-bar callback URL and you call `GoogleWorkspaceLoginComplete`.\n\n"
            "After you get the URL:\n"
            "- If `callback_mode=assisted`, ask the user to open the URL, approve Google access, "
            "and then return to the conversation after the browser shows success. Do NOT ask them "
            "to copy the callback URL.\n"
            "- If `callback_mode=manual`, tell the user to open the URL, approve access, then copy "
            "the full address-bar URL back here so you can call `GoogleWorkspaceLoginComplete`.\n\n"
            "IMPORTANT:\n"
            "- Scope: this tool always requests `--services user` which is gogcli's alias for all\n"
            "  user-facing services (Gmail+Drive+Calendar+Docs+Slides+Sheets+Chat+Tasks+...). Covers\n"
            "  the full Workspace surface in one consent, so the user never needs to re-authorize for\n"
            "  new services.\n"
            "- Show the URL to the user verbatim. DO NOT paraphrase or shorten.\n"
            "- If state expires (user took >10 min), rerun this tool to get a fresh URL.\n"
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
                            "description": "The Google account email to bind, e.g. 'you@gmail.com'.",
                        },
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
        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        email = (args.get("email") or "").strip()
        if not email or "@" not in email:
            return ToolResult(data={"ok": False, "error": "email 参数无效"})

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={"ok": False, "error": "gogcli 未预装。请联系管理员执行: bash scripts/install-gogcli-cli.sh"}
            )

        if not _sandbox_config.has_gogcli_client_config(user_id):
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "[GOGCLI_CLIENT_CONFIG_REQUIRED] 当前 user 还没绑 Desktop OAuth Client。"
                        "请先让用户在 GCP Console 建 Desktop OAuth Client 并下载 client_secret.json，"
                        "把 JSON 粘到对话里，然后调 GoogleWorkspaceClientConfigSet 工具绑定。"
                    ),
                }
            )

        ensure_gogcli_keyring_password(_sandbox_config, user_id)
        write_nsjail_config(_sandbox_config, user_id)
        assisted_callback_url = resolve_gogcli_oauth_callback_url(
            request_base_url=context.request_public_base_url,
        )
        cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(email)} --services user --remote --step 1"
        if assisted_callback_url:
            cmd += f" --redirect-uri {_shq(assisted_callback_url)}"
        try:
            stdout, stderr, code = await asyncio.wait_for(
                execute_in_sandbox(cmd, _sandbox_config, user_id, timeout=20),
                timeout=25,
            )
        except asyncio.TimeoutError:
            return ToolResult(data={"ok": False, "error": "gog auth add step 1 超时"})

        if code != 0:
            logger.warning("user {} gog auth add step 1 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"gog auth add step 1 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}",
                }
            )

        merged = stdout + "\n" + stderr
        m = _OAUTH_URL_PATTERN.search(merged)
        if not m:
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "没能从 gog 输出里抓到 OAuth URL。可能 gog 版本变了输出格式。"
                        f"stdout 片段: {stdout[-300:]}  stderr 片段: {stderr[-300:]}"
                    ),
                }
            )
        url = m.group(0).rstrip(".,;)")

        callback_mode = "manual"
        next_text = (
            "把 `oauth_url` 的**完整 URL 原文**发给用户，并告诉他：\n"
            "  1. 在**本机浏览器**打开这个 URL；\n"
            "  2. 用想绑定的 Google 账号登录；\n"
            "  3. 审查申请的权限后点 'Allow / 允许'；\n"
            "  4. 浏览器会跳到 http://127.0.0.1:<端口>/oauth2/callback?code=...&state=...\n"
            "     页面会显示'无法连接'——这是正常的，因为本地没有 server；\n"
            "  5. 把**地址栏里完整的 URL**复制下来贴回对话；\n"
            "  6. 你会调 GoogleWorkspaceLoginComplete 完成授权。\n"
            "state 10 分钟后失效；超时请重跑本工具。"
        )
        if assisted_callback_url:
            state = extract_oauth_state(url)
            if state:
                register_pending_gogcli_oauth(
                    state=state,
                    user_id=user_id,
                    email=email,
                    redirect_uri=assisted_callback_url,
                )
                callback_mode = "assisted"
                next_text = (
                    "把 `oauth_url` 的完整 URL 原文发给用户，并告诉他：\n"
                    "  1. 在浏览器打开这个 URL；\n"
                    "  2. 用想绑定的 Google 账号登录并点 Allow / 允许；\n"
                    "  3. 浏览器显示 Ripple 授权完成后，回到对话告诉你'好了'。\n"
                    "不要让用户复制 127.0.0.1 callback URL；Ripple 后端会自动完成 gog step 2。\n"
                    "state 10 分钟后失效；超时请重跑本工具。"
                )
            else:
                logger.warning("user {} gog auth step 1 启用了 assisted callback 但没解析到 state", user_id)

        return ToolResult(
            data={
                "ok": True,
                "stage": "awaiting_browser_callback" if callback_mode == "assisted" else "awaiting_user_callback_url",
                "callback_mode": callback_mode,
                "oauth_url": url,
                "email": email,
                "expires_in_seconds": 600,
                "assisted_callback_url": assisted_callback_url if callback_mode == "assisted" else None,
                "next": next_text,
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
