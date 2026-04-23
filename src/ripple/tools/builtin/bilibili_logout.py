"""BilibiliLogout — 解绑当前 user 的 Bilibili 凭证

只做一件事：删 `credentials/bilibili.json` + 重生 nsjail.cfg（使沙箱内
`/workspace/.bilibili/sessdata.json` 不再挂载）。本地删除**不**调用 B 站 passport
退出接口（避免诱发 B 站风控或影响用户其他设备的登录态）——它纯粹是"让本 user
沙箱忘掉这个 SESSDATA"，用户在手机/浏览器上的 B 站登录不受影响。

触发时机：
  * 用户明说"解绑 / 退出 B 站 / 忘掉我的 bilibili 账号"；
  * 切换到别的 B 站账号前（agent 先 logout 再 BilibiliLoginStart 即可）。

破坏性：LOW-MODERATE（删宿主 credentials 文件）。因此要求 agent 在调用前**先问
一下用户确认**，不要自己主动触发。

风险等级：DANGEROUS（凭证删除不可撤销，只能重新扫码恢复）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.bilibili import clear_bilibili_credential
from ripple.sandbox.bilibili_gate import release_gate
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bilibili_logout")


class BilibiliLogoutTool(Tool):
    """解绑 B 站 SESSDATA（per-user）"""

    def __init__(self):
        self.name = "BilibiliLogout"
        self.description = (
            "Unbind the current user's Bilibili SESSDATA by deleting the on-disk\n"
            "credentials file and regenerating nsjail.cfg so the sandbox no longer\n"
            "sees `/workspace/.bilibili/sessdata.json`.\n\n"
            "This does NOT call Bilibili's passport logout endpoint — the user stays\n"
            "logged in on their phone / browser / other devices. It only makes this\n"
            "ripple user 'forget' the SESSDATA.\n\n"
            "Parameters: none.\n\n"
            "IMPORTANT:\n"
            "- Confirm with the user FIRST before calling — this is not reversible\n"
            "  without a new QR-code login.\n"
            "- Only call when the user explicitly says something like '解绑 / 退出 / 忘掉\n"
            "  我的 B 站' or wants to switch Bilibili accounts.\n"
        )
        self.risk_level = ToolRiskLevel.DANGEROUS

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
        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        # 兜底：Logout 同时充当「取消扫码流程」的语义——释放 per-user 扫码闸门。
        # 如果本来就没持有也无副作用（release 返回 False）。
        gate_was_held = release_gate(user_id, "logout")

        removed = clear_bilibili_credential(_sandbox_config, user_id)
        try:
            write_nsjail_config(_sandbox_config, user_id)
        except OSError as e:
            logger.error("user {} logout 后重生 nsjail.cfg 失败: {}", user_id, e)
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"凭证文件已删，但重生 nsjail.cfg 失败: {e}",
                    "credential_removed": removed,
                }
            )

        return ToolResult(
            data={
                "ok": True,
                "credential_removed": removed,
                "pending_scan_cancelled": gate_was_held,
                "next": (
                    "已解绑本 user 的 B 站 SESSDATA。下次调 bilibili skill 时会重新走扫码"
                    "登录流程；用户在其他设备上的 B 站登录态不受影响。"
                    if removed
                    else (
                        "本来就没绑定；但刚才的扫码流程已取消，派发闸门已释放。"
                        if gate_was_held
                        else "本来就没绑定，无事发生。"
                    )
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
