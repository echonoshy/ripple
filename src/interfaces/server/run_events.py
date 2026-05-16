"""SSE helpers for external agent run event logs."""

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from pathlib import Path

from ripple.agent_runners.models import AgentRunnerStatus

TERMINAL_STATUSES = {
    AgentRunnerStatus.COMPLETED.value,
    AgentRunnerStatus.FAILED.value,
    AgentRunnerStatus.CANCELLED.value,
}


def _sse_data(payload: object) -> str:
    if payload == "[DONE]":
        return "data: [DONE]\n\n"
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _read_events_from_offset(events_file: Path, offset: int) -> tuple[list[dict], int]:
    if not events_file.exists():
        return [], offset
    events: list[dict] = []
    with events_file.open("r", encoding="utf-8") as handle:
        handle.seek(offset)
        for line in handle:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events, handle.tell()


def _initial_offset(events_file: Path, from_start: bool) -> int:
    if from_start or not events_file.exists():
        return 0
    return events_file.stat().st_size


async def stream_run_events(
    *,
    events_file: Path,
    get_status: callable,
    from_start: bool = True,
    follow: bool = True,
    heartbeat_seconds: int = 8,
) -> AsyncGenerator[str, None]:
    offset = _initial_offset(events_file, from_start)
    last_emit = time.monotonic()

    while True:
        events, offset = _read_events_from_offset(events_file, offset)
        for event in events:
            yield _sse_data(event)
            last_emit = time.monotonic()

        status = get_status()
        status_value = getattr(status, "value", status)
        if not follow or status_value in TERMINAL_STATUSES:
            yield _sse_data("[DONE]")
            return

        now = time.monotonic()
        if now - last_emit >= max(1, heartbeat_seconds):
            yield _sse_data({"type": "heartbeat", "ts": int(time.time())})
            last_emit = now
        await asyncio.sleep(0.05)
