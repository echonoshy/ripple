"""BilibiliLoginPoll — 扫码登录的第 2 步：检查用户是否已扫码 + 在 App 里点了确认登录

### 两段式登录流程（v2）

从 v2 起，登录流程拆成两个 agent turn：

1. **Turn N**：agent 调 :class:`BilibiliLoginStartTool` → 把二维码链接贴给用户 →
   **结束 turn**（不在同 turn 内立即调 poll）。
2. **Turn N+1**：用户扫完 + 在 App 里点『确认登录』后，主动回一句"好了 / 扫好了 /
   ok"；agent 才在这个 turn 内调 :class:`BilibiliLoginPollTool`。因为 B 站侧已经
   处于 ready 状态，poll 通常几秒内就返回 ``state=ok``。

### 工具返回的 ``state``

* ``ok``      —— 用户已完成授权；凭证已落盘，nsjail.cfg 已重生。闸门释放。
* ``expired`` —— 二维码已失效（B 站侧 TTL 180s）。闸门释放；需要重新 ``LoginStart``。
* ``pending`` —— 工具在 ``max_wait_seconds`` 内**没**等到 terminal 状态。**闸门保持
                 持有**，用户仍在扫码窗口中。附带 ``last_state`` 区分：
                 * ``waiting_scan`` —— 用户还没扫；agent 应让用户确认"有没有扫？"；
                 * ``scanned``      —— 用户扫了但没点『确认登录』；agent 应提示
                   用户"在 B 站 App 里点一下『确认登录』再回我"。
* ``timeout`` —— 仅当 agent 显式传较大 ``max_wait_seconds``（≥ 90s）时，用于和
                 ``pending`` 区分语义：我们在阻塞里等了很久仍无结果，可能是用户
                 真的放弃了。闸门释放。

### 默认参数为什么降到 30s？

旧版默认 180s 的服务端阻塞 poll 在两段式下已经不需要——用户说"好了"才触发 poll，
B 站侧基本秒级 ready。30s 是一个"足以容忍 B 站自身传播延迟 + 一次用户漏点确认"
的折中：极限情况下多 1 个 turn 让 agent 提醒用户点确认即可。

风险等级：BENIGN（写 per-user credential 文件 + 重生 per-user nsjail.cfg）。
"""

import asyncio
import time
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.bilibili import (
    qrcode_poll,
    read_bilibili_credential,
    verify_credential_live,
    write_bilibili_credential,
)
from ripple.sandbox.bilibili_gate import release_gate
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bilibili_login_poll")

DEFAULT_MAX_WAIT_SECONDS = 30
DEFAULT_POLL_INTERVAL_SECONDS = 2.0
MAX_ALLOWED_WAIT_SECONDS = 300  # 硬上限，防止 agent 传巨大数值把会话拖死
# pending 与 timeout 的边界：agent 显式传 >= 90s 才会出现 timeout，否则一律 pending。
PENDING_VS_TIMEOUT_BOUNDARY_SECONDS = 90


def _mask_sessdata(sessdata: str) -> str:
    if not sessdata:
        return ""
    if len(sessdata) <= 8:
        return sessdata[:2] + "..."
    return sessdata[:6] + f"...({len(sessdata)} chars)"


class BilibiliLoginPollTool(Tool):
    """轮询 B 站扫码状态，用户确认扫完后才调用（第 2 步）"""

    def __init__(self):
        self.name = "BilibiliLoginPoll"
        self.description = (
            "Check whether the user has finished scanning the QR code produced by "
            "BilibiliLoginStart, and persist the credential if they have.\n\n"
            "**When to call (two-turn flow)**:\n"
            "  - Call this in a NEW turn AFTER the user has confirmed they scanned the QR\n"
            "    and tapped '确认登录' in the Bilibili App — typically after they reply with\n"
            "    '好了 / 扫好了 / ok / done' or similar.\n"
            "  - Do NOT call this in the same turn as BilibiliLoginStart. Give the user time\n"
            "    to actually scan; the poll is short (default 30s wait) so if the user hasn't\n"
            "    scanned yet you'll just get back state='pending' and waste a turn.\n\n"
            "Parameters:\n"
            "- qrcode_key (required, string): the opaque key returned by BilibiliLoginStart.\n"
            "- max_wait_seconds (optional, int, default 30, hard cap 300): how long the\n"
            "  server will keep checking before returning. Default 30 is enough when the\n"
            "  user just said they're done scanning. Only pass larger values (e.g. 90+) if\n"
            "  you specifically want to emulate the old long-blocking behavior.\n\n"
            "Returns `state` (string) — one of:\n"
            "  - 'ok'       — user scanned AND tapped 确认登录. Credential has been persisted\n"
            "                 to the user's sandbox (`credentials/bilibili.json`) and\n"
            "                 nsjail.cfg was regenerated — the next Bash command will see\n"
            "                 SESSDATA at `/workspace/.bilibili/sessdata.json`. Response also\n"
            "                 includes `uname`, `mid`, `expires_at` for user acknowledgement.\n"
            "  - 'expired'  — QR expired (Bilibili-side 180s TTL). Scan gate released. Ask\n"
            "                 the user '要不要重新生成一张？' and call BilibiliLoginStart again.\n"
            "  - 'pending'  — we polled max_wait_seconds and the state is still not terminal.\n"
            "                 Scan gate is STILL HELD. The response includes `last_state`:\n"
            "                   * 'waiting_scan' → user hasn't actually scanned yet; tell\n"
            "                     them '好像还没收到扫码，二维码还在那张链接里，麻烦扫一下'.\n"
            "                   * 'scanned' → they scanned but didn't tap 确认登录; tell\n"
            "                     them '扫到了，但还要在 B 站 App 里点一下『确认登录』。点完\n"
            "                     再回我一句我重试'. DO NOT call BilibiliLoginPoll again in\n"
            "                     the same turn — wait for the user to reply first.\n"
            "  - 'timeout'  — only returned when max_wait_seconds >= 90 and we still got\n"
            "                 nothing. Scan gate released. Same UX as expired: offer to\n"
            "                 regenerate the QR.\n\n"
            "IMPORTANT:\n"
            "- Do NOT surface SESSDATA / bili_jct in your reply; response intentionally masks\n"
            "  them. Use `uname` + `mid` for confirmation messages.\n"
            "- On 'pending' the gate is still held — the user is expected to finish scanning;\n"
            "  reply with the appropriate hint and END the turn, then call poll again in the\n"
            "  next turn when the user confirms.\n"
            "- Only continue to the original task (video extract, auto-md, etc.) AFTER this\n"
            "  tool returns state='ok'. On 'expired' / 'timeout' — do NOT silently downgrade\n"
            "  to unauthenticated mode unless the user explicitly says so.\n"
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
                        "qrcode_key": {
                            "type": "string",
                            "description": "Opaque qrcode_key returned by BilibiliLoginStart.",
                        },
                        "max_wait_seconds": {
                            "type": "integer",
                            "description": (
                                "Max seconds the server will poll before returning. "
                                "Default 30 (two-turn flow — user already confirmed scan). "
                                "Hard cap 300. Pass >=90 to opt into the old long-blocking "
                                "semantics and get state='timeout' instead of 'pending'."
                            ),
                            "minimum": 5,
                            "maximum": MAX_ALLOWED_WAIT_SECONDS,
                        },
                    },
                    "required": ["qrcode_key"],
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

        qrcode_key = (args.get("qrcode_key") or "").strip()
        if not qrcode_key:
            # 参数坏掉不动闸门：闸门对应的 qrcode_key 由 LoginStart 记录，
            # 这里无 key 可对、也无 state 可交代，交给后续正经 poll 或超时来收拾。
            return ToolResult(data={"ok": False, "error": "qrcode_key 参数为空"})

        max_wait = int(args.get("max_wait_seconds") or DEFAULT_MAX_WAIT_SECONDS)
        max_wait = max(5, min(max_wait, MAX_ALLOWED_WAIT_SECONDS))
        interval = DEFAULT_POLL_INTERVAL_SECONDS

        logger.info(
            "user {} 轮询 B 站扫码状态 (key={}, max_wait={}s)",
            user_id,
            qrcode_key[:8] + "...",
            max_wait,
        )

        # 仅 terminal 状态（ok / expired / timeout）需要释放闸门；
        # pending 意味着用户仍在扫码窗口中，闸门保持持有供下一 turn 继续 poll。
        release_reason: str | None = None
        try:
            deadline = time.monotonic() + max_wait
            last_state: str = "waiting_scan"
            result: dict[str, Any] = {}
            while True:
                now = time.monotonic()
                if now >= deadline:
                    # 根据 agent 传入的 max_wait 判定这是"短等待 pending"还是"长等待 timeout"。
                    # pending 保持闸门；timeout 释放闸门。
                    is_long_wait = max_wait >= PENDING_VS_TIMEOUT_BOUNDARY_SECONDS
                    if is_long_wait:
                        logger.info(
                            "user {} 扫码长等待超时 (等了 {}s, 最终状态={})",
                            user_id,
                            max_wait,
                            last_state,
                        )
                        release_reason = "poll_timeout"
                        return ToolResult(
                            data={
                                "ok": True,
                                "state": "timeout",
                                "last_state_before_timeout": last_state,
                                "waited_seconds": max_wait,
                                "next": (
                                    f"等了 {max_wait}s 用户仍未完成扫码。告诉用户『我这边"
                                    "等超时了，要不要重新生成二维码？』——得到肯定答复后再调"
                                    " `BilibiliLoginStart`。**不要**静默降级成未登录模式。"
                                ),
                            }
                        )
                    # 短等待 pending：闸门保持持有，等用户下一 turn 确认后再 poll。
                    logger.info(
                        "user {} 扫码短等待到期 pending (等了 {}s, 最终状态={})",
                        user_id,
                        max_wait,
                        last_state,
                    )
                    if last_state == "scanned":
                        hint = (
                            "B 站那边收到扫码了，但还没看到用户在 App 里点『确认登录』。"
                            "告诉用户：『扫到了，但你还要在 B 站 App 里点一下『确认登录』。"
                            "点完回我一句我重试。』然后**结束本 turn**，等用户回话再调一次"
                            " BilibiliLoginPoll。"
                        )
                    elif last_state == "waiting_scan":
                        hint = (
                            "B 站那边还没收到扫码。可能用户没打开 App / 还没扫。告诉用户："
                            "『好像还没收到扫码——二维码还在那张链接里，麻烦扫一下，扫完回我。』"
                            "然后**结束本 turn**，等用户回话再调一次 BilibiliLoginPoll。"
                        )
                    else:
                        hint = (
                            "短等待里 B 站状态仍未进入 ok/expired 终态。"
                            "告诉用户『还没看到扫码完成，麻烦再在 App 里点一下『确认登录』。』"
                            "然后**结束本 turn**，等用户回话再调一次 BilibiliLoginPoll。"
                        )
                    # 闸门保持持有，不设 release_reason，finally 不释放。
                    return ToolResult(
                        data={
                            "ok": True,
                            "state": "pending",
                            "last_state": last_state,
                            "waited_seconds": max_wait,
                            "next": hint,
                        }
                    )

                try:
                    # qrcode_poll 是同步 urllib 调用，扔到线程池避免阻塞事件循环
                    result = await asyncio.to_thread(qrcode_poll, qrcode_key)
                except RuntimeError as e:
                    logger.warning("user {} 轮询 B 站二维码失败: {}", user_id, e)
                    # 网络抖动等瞬态错误：不立刻放弃，等下一轮
                    await asyncio.sleep(interval)
                    continue

                state = result.get("state", "unknown")
                last_state = state

                if state == "expired":
                    logger.info("user {} 扫码二维码已过期", user_id)
                    release_reason = "poll_expired"
                    return ToolResult(
                        data={
                            "ok": True,
                            "state": "expired",
                            "raw_code": result.get("raw_code"),
                            "next": (
                                "二维码已失效。问用户『要不要重新生成一张？』，同意后再调"
                                " BilibiliLoginStart。**不要**静默降级。"
                            ),
                        }
                    )

                if state == "ok":
                    break

                # waiting_scan / scanned / unknown：继续等
                await asyncio.sleep(interval)

            # ── state == "ok" 分支：落盘凭证 ──
            fields = result.get("credential_fields") or {}
            sessdata = fields.get("sessdata") or ""
            if not sessdata:
                release_reason = "poll_ok_but_missing_sessdata"
                return ToolResult(
                    data={
                        "ok": False,
                        "error": "B 站扫码接口返回成功状态但未含 SESSDATA，请让用户重试。",
                    }
                )

            already = read_bilibili_credential(_sandbox_config, user_id)
            if already and already.get("sessdata") == sessdata:
                logger.info("user {} SESSDATA 已绑定且一致，跳过二次写入", user_id)
                release_reason = "poll_ok_already_bound"
                return ToolResult(
                    data={
                        "ok": True,
                        "state": "ok",
                        "already_bound": True,
                        "uname": already.get("uname"),
                        "mid": already.get("mid"),
                        "expires_at": already.get("expires_at"),
                        "sessdata_preview": _mask_sessdata(sessdata),
                        "next": "凭证之前已落盘，可以直接回到原业务。",
                    }
                )

            nav_info = await asyncio.to_thread(verify_credential_live, sessdata)
            if not nav_info.get("is_login"):
                logger.warning(
                    "user {} 扫码成功但 /nav 验证未通过: {}",
                    user_id,
                    nav_info.get("raw_log"),
                )

            credential = {
                "sessdata": sessdata,
                "bili_jct": fields.get("bili_jct", ""),
                "dede_user_id": fields.get("dede_user_id", ""),
                "dede_user_id_ck_md5": fields.get("dede_user_id_ck_md5", ""),
                "uname": nav_info.get("uname") or "",
                "mid": nav_info.get("mid") or 0,
                "bound_at": int(time.time()),
                "expires_at": fields.get("expires_at", 0),
            }

            try:
                await asyncio.to_thread(write_bilibili_credential, _sandbox_config, user_id, credential)
                await asyncio.to_thread(write_nsjail_config, _sandbox_config, user_id)
            except OSError as e:
                logger.error("user {} 写入 bilibili.json 失败: {}", user_id, e)
                release_reason = "poll_ok_but_write_failed"
                return ToolResult(data={"ok": False, "error": f"落盘失败: {e}"})

            logger.info(
                "user {} B 站扫码登录成功: uname={} mid={} sessdata={}",
                user_id,
                credential["uname"] or "<unknown>",
                credential["mid"],
                _mask_sessdata(sessdata),
            )

            release_reason = "poll_ok"
            return ToolResult(
                data={
                    "ok": True,
                    "state": "ok",
                    "uname": credential["uname"],
                    "mid": credential["mid"],
                    "expires_at": credential["expires_at"],
                    "sessdata_preview": _mask_sessdata(sessdata),
                    "nav_verified": bool(nav_info.get("is_login")),
                    "next": (
                        "B 站账号已绑定到当前 user 沙箱（per-user 严格隔离）。现在可以继续原业务，"
                        "向用户 ack 时用 `uname` 即可，绝不要回显 SESSDATA。"
                    ),
                }
            )
        except BaseException:
            # 异常退出（协程取消 / 未捕获错误）时强制释放闸门，避免 user 被卡死。
            if release_reason is None:
                release_reason = "poll_abnormal_exit"
            raise
        finally:
            # pending 路径把 release_reason 留成 None，不释放闸门（用户仍在扫码窗口）；
            # 其它 terminal 状态（ok / expired / timeout / 异常）都释放。
            if release_reason is not None:
                release_gate(user_id, release_reason)

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
