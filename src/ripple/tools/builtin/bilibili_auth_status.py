"""BilibiliAuthStatus — 查当前 user 的 Bilibili 绑定状态

用途：
  * Bilibili skill 在真正干活前先调一次，决定是直接执行还是先引导扫码登录。
  * 用户问"我绑的是哪个 B 站号 / 什么时候过期"时，agent 可以直接展示。

不会返回任何敏感字段（SESSDATA / bili_jct 都不透出），只返回：
  * bound (bool)
  * uname / mid / expires_at（如果绑定过）
  * validated (bool) / raw_log —— 仅当 verify=True 时打一次 /nav 确认仍然有效

默认 verify=False，因为 SESSDATA 通常有效期很长（30 天起），没必要每次都打一次
外网接口；只在用户怀疑"是不是已经失效了"、或者 agent 看到字幕接口返回 -101
之类的疑似失效信号时，主动传 verify=True 去验证。

风险等级：SAFE（只读）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.bilibili import read_bilibili_credential, verify_credential_live
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bilibili_auth_status")


class BilibiliAuthStatusTool(Tool):
    """查 Bilibili 绑定状态"""

    def __init__(self):
        self.name = "BilibiliAuthStatus"
        self.description = (
            "Check whether the current user has a Bilibili SESSDATA bound, and optionally\n"
            "verify it is still live.\n\n"
            "Parameters:\n"
            "- verify (optional bool, default false): when true, additionally hits B 站\n"
            "  `/x/web-interface/nav` to confirm the SESSDATA is still live. Leave this\n"
            "  off in the common case (SESSDATA is typically valid for 30+ days) — only\n"
            "  set it when you have concrete evidence of expiry (e.g. a subtitle fetch\n"
            "  returned 'status: need_sessdata' even though bound=true).\n\n"
            "Returns:\n"
            "  - bound (bool): is there a non-empty sessdata on disk?\n"
            "  - uname, mid, expires_at: identity info (safe to show to the user).\n"
            "  - validated (bool, only when verify=true): did /nav succeed?\n\n"
            "Response fields worth surfacing:\n"
            "  - bound (bool), uname (str), mid (int).\n"
            "  - expires_at (int, unix ts; 0 = unknown/legacy record).\n"
            "  - days_until_expiry (int or null): null = unknown; int = days remaining.\n"
            "    If <= 7 and the user is starting a new Bilibili task, proactively\n"
            "    warn them (『你的 B 站登录还有 N 天到期，要不要顺便续一下？』) — don't\n"
            "    wait until the pipeline hard-fails mid-task.\n\n"
            "Typical usage before starting a Bilibili pipeline (two-turn login flow):\n"
            "  1. Call BilibiliAuthStatus.\n"
            "  2. If bound=false → IMMEDIATELY call BilibiliLoginStart in the same turn.\n"
            "     Reply with ONLY the `qrcode_image_url` as a markdown link plus a short\n"
            "     instruction asking the user to scan + tap 确认登录 in the B 站 App AND\n"
            "     reply back with '好了 / ok / 扫好了'. Then END the turn. Do NOT call\n"
            "     BilibiliLoginPoll in the same turn — the user hasn't scanned yet and\n"
            "     blocking them behind a long 'processing' spinner is bad UX.\n"
            "     In the NEXT turn, when the user confirms, call BilibiliLoginPoll.\n"
            "     Do NOT ask 'do you want to log in?' — the default assumption is yes;\n"
            "     the user will interrupt if they don't want to. Do NOT silently fall back\n"
            "     to a metadata-only degraded output — that's bad UX and forbidden by skill\n"
            "     rules. Degradation is only allowed when the user explicitly said\n"
            "     '不要登录 / 不用登录 / 就用元数据 / 直接给我'.\n"
            "  3. If bound=true → proceed with the pipeline; fall back to the login flow\n"
            "     only if the pipeline later complains '[BILIBILI_AUTH_REQUIRED]'.\n"
            "\n"
            "This tool NEVER returns the raw SESSDATA or bili_jct — only non-sensitive\n"
            "identity fields."
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
                        "verify": {
                            "type": "boolean",
                            "description": "Whether to additionally hit /nav to check liveness. Default false.",
                        },
                    },
                    "required": [],
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

        verify = bool(args.get("verify", False))
        cred = read_bilibili_credential(_sandbox_config, user_id)

        if cred is None:
            return ToolResult(
                data={
                    "ok": True,
                    "bound": False,
                    "next": (
                        "当前 user 未绑定 B 站账号。**默认路径**（两段式扫码登录）：\n"
                        "  1. **本 turn**：立刻调 `BilibiliLoginStart`；在回复里**只给**用户"
                        "两样东西——markdown 链接 `[点此查看扫码二维码](qrcode_image_url)`、"
                        "以及一句指引『请用 B 站 App 扫一扫 → 在 App 里点『确认登录』→ 扫完"
                        "回我一句「好了」我再继续』。然后**结束 turn**。\n"
                        "  2. **不要**在本 turn 内调 `BilibiliLoginPoll`；**绝不**渲染任何"
                        "ASCII/Unicode 二维码（只给链接即可）。\n"
                        "  3. 等用户下一 turn 回『好了/ok/扫好了』——**那时**才调"
                        " `BilibiliLoginPoll(qrcode_key=...)`，成功后继续原业务。\n"
                        "  4. 若用户改口说『算了/不登录了/超时了』，改调 `BilibiliLogout`"
                        "释放闸门。\n"
                        "禁止未登录就产出带『⚠️ 未登录』警告的降级结果；唯一允许降级的前置"
                        "条件是用户对话里明说过『不要登录 / 不用登录 / 就用元数据 / 直接给我』。"
                    ),
                }
            )

        # 算一下剩余多少天——给 agent 一个"临期主动提醒续期"的信号。
        # expires_at 可能是 0（历史凭证没记录）或未来 unix ts。
        import time  # noqa: PLC0415

        expires_at = int(cred.get("expires_at") or 0)
        now = int(time.time())
        days_until_expiry: int | None
        if expires_at <= 0:
            days_until_expiry = None  # 未知：历史凭证没这字段
        else:
            days_until_expiry = max(0, (expires_at - now) // 86400)

        out: dict = {
            "ok": True,
            "bound": True,
            "uname": cred.get("uname") or "",
            "mid": cred.get("mid") or 0,
            "expires_at": expires_at,
            "bound_at": cred.get("bound_at") or 0,
            # None = 未知；整数 = 剩余天数。agent 可用 "<=7 天就主动提醒续期"
            # 的策略，避免用户在半夜临期时突然被打断。
            "days_until_expiry": days_until_expiry,
        }

        if verify:
            nav = verify_credential_live(cred["sessdata"])
            out["validated"] = bool(nav.get("is_login"))
            if not nav.get("is_login"):
                out["validate_error"] = nav.get("raw_log") or "nav 接口未返回 isLogin=true"
                out["next"] = "SESSDATA 可能已失效，请调 BilibiliLoginStart 重新扫码登录。"
            else:
                if nav.get("uname"):
                    out["uname"] = nav["uname"]
                if nav.get("mid"):
                    out["mid"] = nav["mid"]

        return ToolResult(data=out)

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return True
