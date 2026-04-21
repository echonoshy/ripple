"""user 级锁：同一 user 的工具调用互斥，不同 user 并行"""

import asyncio
from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


@pytest.mark.asyncio
async def test_same_user_lock_serializes(tmp_path: Path):
    from ripple.sandbox import manager as mgr

    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]

    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    m = SandboxManager(cfg)
    m.ensure_sandbox("alice")

    events: list[str] = []

    async def worker(name: str):
        async with m.user_lock("alice"):
            events.append(f"{name}-enter")
            await asyncio.sleep(0.05)
            events.append(f"{name}-exit")

    await asyncio.gather(worker("A"), worker("B"))
    assert events[0].endswith("-enter")
    assert events[1].endswith("-exit")
    assert events[2].endswith("-enter")
    assert events[3].endswith("-exit")


@pytest.mark.asyncio
async def test_different_users_parallel(tmp_path: Path):
    from ripple.sandbox import manager as mgr

    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]

    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    m = SandboxManager(cfg)
    m.ensure_sandbox("alice")
    m.ensure_sandbox("bob")

    started: dict[str, float] = {}

    async def worker(uid: str):
        async with m.user_lock(uid):
            started[uid] = asyncio.get_event_loop().time()
            await asyncio.sleep(0.05)

    await asyncio.gather(worker("alice"), worker("bob"))
    assert abs(started["alice"] - started["bob"]) < 0.02
