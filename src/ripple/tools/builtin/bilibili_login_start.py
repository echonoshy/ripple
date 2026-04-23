"""BilibiliLoginStart — 向 B 站申请扫码登录二维码，返回给用户扫描

扫码登录 2 步流程的**第 1 步**（第 2 步 `BilibiliLoginPoll` 会等用户完成扫码）：

  1. 本工具调 ``https://passport.bilibili.com/x/passport-login/web/qrcode/generate``
     拿到 qrcode_key + 要扫的 URL。
  2. 把这个 URL 以**一种**形式返回给前端：
       * ``qrcode_image_url`` —— 指向 ripple 自己的 ``/v1/bilibili/qrcode.png`` 路由，
         用户在浏览器里打开就能看到一张可扫的 PNG 二维码；
       * ``qrcode_content`` —— 被 encode 进 QR 的原始字符串（调试用，不要给用户）。
     （旧版还返回 ``qrcode_ascii`` Unicode 方块，在 Web UI 场景只会污染对话 + 浪费
       token，从 v2 起**不再返回**；如将来有纯 CLI 场景需要再加回。）
  3. agent 把 ``qrcode_image_url`` 以 markdown 链接形式贴给用户，然后**结束本次
     turn**——**不要**在同一 turn 内立刻调 ``BilibiliLoginPoll``。
  4. 用户扫完 + 在 App 里点"确认登录"，主动回一句"好了/扫好了/ok"；agent 的**下一
     个** turn 才调 ``BilibiliLoginPoll`` 拿凭证（那时 B 站侧状态已经 ready，
     poll 几秒内返回）。

为什么改成"两段式"（不再同 turn 立即 poll）？
  * 同 turn 立即阻塞 poll，用户体感是"AI 一直在处理中"，而且没法中途说"我取消"；
  * 两段式把控制权交还给用户：他扫完再触发 poll，自然优雅；
  * B 站扫码窗口 TTL 180s；用户迟迟不回，闸门（:mod:`bilibili_gate`）有 TTL
    自动清理，不会死锁。

关键特性：
  * **无需 F12 / DevTools / 复制 Cookie**——用户只要打开 B 站 App 扫码就行。
  * 二维码 TTL 约 180 秒，超时要重新调本工具生成新的。
  * PNG 不作为 base64 内嵌到对话，而是让用户在浏览器打开 ``qrcode_image_url``
    获取——避免污染对话历史和 LLM token 消耗。

风险等级：SAFE（只读 B 站开放接口，不产生副作用）。
"""

import urllib.parse
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.bilibili import QRCODE_TTL_SECONDS, qrcode_generate
from ripple.sandbox.bilibili_gate import acquire_gate
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bilibili_login_start")


class BilibiliLoginStartTool(Tool):
    """申请 B 站扫码登录二维码（第 1 步）"""

    def __init__(self):
        self.name = "BilibiliLoginStart"
        self.description = (
            "Start the Bilibili QR-code login flow (step 1 of 2). Use this whenever you "
            "need to bind (or re-bind) a user's Bilibili SESSDATA — e.g. the user is about "
            "to use a Bilibili skill for the first time, or a previous SESSDATA expired.\n\n"
            "Parameters: none.\n\n"
            "Returns JSON including:\n"
            "  - qrcode_key: opaque token; pass it to BilibiliLoginPoll in step 2.\n"
            "  - qrcode_image_url: relative URL like `/v1/bilibili/qrcode.png?content=...`.\n"
            "    When opened in a browser, it renders the QR code as a PNG image (cache-60s).\n"
            "    Surface this to the user as a **markdown link** so they can click to open\n"
            "    it in a new tab — do NOT try to embed as ![image](...), the ripple Web UI\n"
            "    may strip or fail to render relative data paths depending on its markdown\n"
            "    renderer.\n"
            "  - qrcode_content: the raw URL encoded inside the QR (debug-only; do NOT surface\n"
            "    to the user — it's the B 站 scan-web landing page, opening it in a browser\n"
            "    just shows a 'download App' redirect, NOT a scannable QR).\n"
            "  - expires_in_seconds: how long this QR is valid (~180s).\n\n"
            "**CRITICAL — two-turn flow (do NOT call BilibiliLoginPoll in the same turn):**\n"
            "  1. In THIS turn, write a reply that ONLY contains:\n"
            "       a. the markdown link `[点此查看扫码二维码](qrcode_image_url)`；\n"
            "       b. a short instruction: '请用 B 站 App 扫一扫 → 在 App 里点『确认登录』\n"
            "          → 扫完后回我一句「好了」我再继续。'\n"
            "     Then END this assistant turn. Do NOT call BilibiliLoginPoll here.\n"
            "  2. Wait for the user to reply (usually '好了 / 扫好了 / ok / done' or similar).\n"
            "     When they do, in the NEXT turn call `BilibiliLoginPoll(qrcode_key=...)` —\n"
            "     by then Bilibili already has the confirmed state and poll returns in seconds.\n"
            "     If the user says 'expired / 超时了 / 算了' or similar cancellation wording,\n"
            "     call `BilibiliLogout` instead to release the scan gate.\n\n"
            "**Never** render or include an ASCII / Unicode-block QR code in the reply — it\n"
            "pollutes the conversation, wastes thousands of input tokens on every subsequent\n"
            "turn, and the image link is always sufficient.\n\n"
            "Never ask the user to paste SESSDATA or open DevTools — the whole point of this\n"
            "tool is to avoid that friction.\n"
            "If BilibiliLoginPoll (next turn) returns state='expired' or 'timeout', call\n"
            "BilibiliLoginStart again for a fresh QR (unless the user says to give up)."
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
                    "properties": {},
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
        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        try:
            gen = qrcode_generate()
        except RuntimeError as e:
            logger.warning("user {} 申请 B 站二维码失败: {}", user_id, e)
            return ToolResult(data={"ok": False, "error": str(e)})

        qrcode_key = gen["qrcode_key"]
        qrcode_content = gen["qrcode_content"]

        # 把 content 编进 URL query，前端打开相对路径时浏览器会 resolve 到
        # ripple server 自身的 /v1/bilibili/qrcode.png 路由渲染 PNG。
        image_url = "/v1/bilibili/qrcode.png?content=" + urllib.parse.quote(qrcode_content, safe="")

        logger.info("user {} 申请 B 站扫码登录，qrcode_key={}", user_id, qrcode_key[:8] + "...")

        # 关上 per-user 扫码互斥闸门：在 BilibiliLoginPoll 返回或 BilibiliLogout
        # 解绑之前，派发层会把本 user 其它工具调用一律劝返，防 agent 抢跑。
        acquire_gate(user_id, qrcode_key)

        return ToolResult(
            data={
                "ok": True,
                "qrcode_key": qrcode_key,
                "qrcode_image_url": image_url,
                "qrcode_content": qrcode_content,
                "expires_in_seconds": QRCODE_TTL_SECONDS,
                "next": (
                    "两段式登录流程——**当前 turn 到此结束**：\n"
                    "  1. 回复里只给用户两样东西：\n"
                    "     * markdown 链接：`[点此查看扫码二维码](qrcode_image_url)`；\n"
                    "     * 一句话指引：『请用 B 站 App 扫一扫 → 在 App 里点『确认登录』\n"
                    "       → 扫完后回我一句「好了」我再继续。』\n"
                    "  2. **不要**在本 turn 里调 BilibiliLoginPoll；**不要**渲染任何\n"
                    "     ASCII/Unicode 二维码——只给链接就够了。\n"
                    "  3. 等用户下一 turn 回『好了/ok/扫好了』，**再**调\n"
                    "     `BilibiliLoginPoll(qrcode_key=<上面的 key>)` 拿凭证。\n"
                    "  4. 若用户改口说『算了/不登录了/超时了』，改调 `BilibiliLogout`\n"
                    "     释放扫码闸门，恢复原有上下文。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
