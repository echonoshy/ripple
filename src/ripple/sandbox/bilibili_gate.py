"""Bilibili 扫码登录期间的 per-user 会话级互斥闸门。

### 为什么存在

当 agent 调用 ``BilibiliLoginStart`` 向用户展示二维码、但用户还没扫完、
``BilibiliLoginPoll`` 还没返回时，我们**不希望 agent 继续跑其它工具**
（抢跑 extract / auto-md / Bash 等）——因为凭证还没落盘，那些工具都会以
``need_sessdata`` 或 401/-101 失败，用户体感就是「AI 让我扫码但自己没等我」。

SKILL 里虽然反复强调「不要抢跑」，但 prompt 约束不是硬约束；这个闸门是**硬
互斥**：无论 agent 怎么抖，只要 user 还在扫码窗口，派发层就会把非白名单工具
挡回，并把 agent 引导回正确路径（调 ``BilibiliLoginPoll`` / ``BilibiliLogout``）。

### 生命周期

``BilibiliLoginStart`` 成功  → :func:`acquire_gate`（记录 qrcode_key + 起始时间）

    ├── 用户扫码完成 → ``BilibiliLoginPoll`` 返回 state=ok/expired/timeout/error
    │                → :func:`release_gate`
    ├── 用户显式解绑 → ``BilibiliLogout`` → :func:`release_gate`
    └── 都没触发     → 超过 :data:`GATE_TTL_SECONDS` 后自动过期清理，防永久死锁

### 作用域

per-``user_id``，进程内内存状态（不落盘）：ripple server 重启后一切重置，和
沙箱凭证的持久化互相独立。多个 session 共享一个 user 的闸门（因为沙箱本身就是
per-user 的，扫码也是在给整个 user 授权）。
"""

import threading
import time
from dataclasses import dataclass

from ripple.utils.logger import get_logger

logger = get_logger("sandbox.bilibili_gate")

# B 站二维码服务端 TTL 是 180s。这里给 agent 多留一段缓冲窗口再强制释放，
# 避免极端情况（poll 异常退出没走到 finally / agent 不调 poll）把 user 卡死。
#
# v2 起改为两段式登录：LoginStart 结束 turn，用户扫完主动回"好了"才触发 poll。
# 用户可能慢慢扫（找手机、打开 App）或中途临时去做别的事，TTL 需要大于 B 站 QR
# 的 180s 才能容忍用户的慢节奏——否则二维码还没过期，闸门先自行清理反而造成
# 新 qrcode_key 和旧闸门错配。600s = 10 分钟，既够用又不会真卡死。
GATE_TTL_SECONDS: float = 600.0


@dataclass(frozen=True)
class PendingAuth:
    """闸门当前持有的扫码会话元信息。"""

    qrcode_key: str
    started_at: float  # time.monotonic()

    def elapsed(self) -> float:
        return time.monotonic() - self.started_at


class BilibiliAuthGate:
    """per-user 扫码 in-flight 互斥闸门。"""

    def __init__(self, ttl_seconds: float = GATE_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._pending: dict[str, PendingAuth] = {}

    def acquire(self, user_id: str, qrcode_key: str) -> None:
        """标记 user 进入扫码等待态；重复调用会覆盖旧的 qrcode_key。"""
        with self._lock:
            prev = self._pending.get(user_id)
            self._pending[user_id] = PendingAuth(
                qrcode_key=qrcode_key,
                started_at=time.monotonic(),
            )
        if prev is not None:
            logger.info(
                "user {} bilibili 扫码闸门被新二维码覆盖 (old_key={}..., new_key={}...)",
                user_id,
                prev.qrcode_key[:8],
                qrcode_key[:8],
            )
        else:
            logger.info(
                "user {} 进入 bilibili 扫码等待区 (key={}...)",
                user_id,
                qrcode_key[:8],
            )

    def release(self, user_id: str, reason: str) -> bool:
        """释放 user 的闸门；返回之前是否持有。"""
        with self._lock:
            existing = self._pending.pop(user_id, None)
        if existing is None:
            return False
        logger.info(
            "user {} 退出 bilibili 扫码等待区 (原因={}, 持续={:.1f}s)",
            user_id,
            reason,
            existing.elapsed(),
        )
        return True

    def status(self, user_id: str) -> PendingAuth | None:
        """返回当前 user 的 pending auth；过期时会原地清理并返回 None。"""
        with self._lock:
            entry = self._pending.get(user_id)
            if entry is None:
                return None
            if entry.elapsed() > self._ttl:
                self._pending.pop(user_id, None)
                logger.warning(
                    "user {} bilibili 扫码闸门超 {:.0f}s 未释放，强制清理 (key={}...)",
                    user_id,
                    self._ttl,
                    entry.qrcode_key[:8],
                )
                return None
            return entry

    def is_blocked(self, user_id: str) -> bool:
        return self.status(user_id) is not None


# 进程内单例。所有工具共享同一把闸门；测试里想重置就调 :func:`reset_gate_for_tests`。
_GATE = BilibiliAuthGate()


def acquire_gate(user_id: str, qrcode_key: str) -> None:
    _GATE.acquire(user_id, qrcode_key)


def release_gate(user_id: str, reason: str) -> bool:
    return _GATE.release(user_id, reason)


def gate_status(user_id: str) -> PendingAuth | None:
    return _GATE.status(user_id)


def is_gate_blocked(user_id: str) -> bool:
    return _GATE.is_blocked(user_id)


def reset_gate_for_tests() -> None:
    """仅供单测使用：清空所有 pending 状态。"""
    global _GATE
    _GATE = BilibiliAuthGate()


# 命中闸门时仍允许派发的工具白名单——紧贴扫码登录流程本身 + 只读查询。
# 任何变更请同步检查 ``orchestration.execute_tool`` 里的拦截分支。
GATE_ALLOWED_TOOLS: frozenset[str] = frozenset(
    {
        "BilibiliLoginStart",
        "BilibiliLoginPoll",
        "BilibiliLogout",
        "BilibiliAuthStatus",
    }
)
