"""Lightweight schedule control-plane helpers.

Schedules only decide when to create a Codex run. They never execute user work
directly; every trigger goes through the existing external agent run path.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ripple.agent_runners.job_store import list_user_job_records, write_job_meta
from ripple.agent_runners.manager import ExternalAgentManager
from ripple.agent_runners.service import start_agent_run
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.users.quota import assert_can_create_run
from ripple.utils.file_state import atomic_write_json, read_json_or_default
from ripple.utils.logger import get_logger

logger = get_logger("schedules")

STATE_VERSION = 1
SCHEDULE_KINDS = {"once", "interval"}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


def _parse_iso_datetime(value: str | None, timezone_name: str) -> datetime | None:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("invalid datetime") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_zoneinfo(timezone_name))
    return parsed.astimezone(timezone.utc)


def _zoneinfo(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"unknown timezone: {timezone_name}") from exc


def _normalize_timezone(value: str | None) -> str:
    timezone_name = (value or "UTC").strip() or "UTC"
    _zoneinfo(timezone_name)
    return timezone_name


def _schedule_state_path(config: SandboxConfig, user_id: str):
    return config.sandbox_dir(user_id) / "schedules" / "schedules.json"


def _read_state(config: SandboxConfig, user_id: str) -> dict[str, Any]:
    raw = read_json_or_default(_schedule_state_path(config, user_id), {})
    if not isinstance(raw, dict):
        raw = {}
    schedules = raw.get("schedules")
    if not isinstance(schedules, dict):
        schedules = {}
    return {"version": STATE_VERSION, "schedules": schedules}


def _write_state(config: SandboxConfig, user_id: str, state: dict[str, Any]) -> None:
    state["version"] = STATE_VERSION
    atomic_write_json(_schedule_state_path(config, user_id), state)


def _copy_schedule(record: dict[str, Any]) -> dict[str, Any]:
    return dict(record)


def _interval_seconds(value: Any) -> int | None:
    if value is None:
        return None
    try:
        interval = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("interval_seconds must be an integer") from exc
    if interval < 1:
        raise ValueError("interval_seconds must be at least 1")
    return interval


def _validate_kind(kind: Any) -> str:
    normalized = str(kind or "once").strip()
    if normalized not in SCHEDULE_KINDS:
        expected = ", ".join(sorted(SCHEDULE_KINDS))
        raise ValueError(f"kind must be one of: {expected}")
    return normalized


def _compute_initial_next_run_at(
    *,
    kind: str,
    run_at: str | None,
    interval_seconds: int | None,
    timezone_name: str,
    now: datetime,
) -> str | None:
    if kind == "once":
        parsed_run_at = _parse_iso_datetime(run_at, timezone_name)
        if parsed_run_at is None:
            raise ValueError("run_at is required for once schedules")
        return _to_iso(parsed_run_at)

    if interval_seconds is None:
        raise ValueError("interval_seconds is required for interval schedules")
    base = _parse_iso_datetime(run_at, timezone_name) or (now + timedelta(seconds=interval_seconds))
    while base <= now:
        base += timedelta(seconds=interval_seconds)
    return _to_iso(base)


def _advance_next_run_at(record: dict[str, Any], now: datetime) -> str | None:
    kind = record.get("kind")
    if kind == "once":
        return None
    if kind != "interval":
        return None
    interval_seconds = _interval_seconds(record.get("interval_seconds"))
    if interval_seconds is None:
        return None
    current_next = _parse_iso_datetime(str(record.get("next_run_at") or ""), str(record.get("timezone") or "UTC"))
    next_run = current_next or now
    while next_run <= now:
        next_run += timedelta(seconds=interval_seconds)
    return _to_iso(next_run)


def list_schedules(config: SandboxConfig, user_id: str) -> list[dict[str, Any]]:
    records = [_copy_schedule(record) for record in _read_state(config, user_id)["schedules"].values()]
    return sorted(records, key=lambda record: str(record.get("next_run_at") or "9999"), reverse=False)


def get_schedule(config: SandboxConfig, user_id: str, schedule_id: str) -> dict[str, Any] | None:
    record = _read_state(config, user_id)["schedules"].get(schedule_id)
    return _copy_schedule(record) if isinstance(record, dict) else None


def create_schedule(config: SandboxConfig, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    now = utc_now()
    kind = _validate_kind(payload.get("kind"))
    timezone_name = _normalize_timezone(payload.get("timezone"))
    interval_seconds = _interval_seconds(payload.get("interval_seconds"))
    run_at = payload.get("run_at")
    if run_at is not None:
        run_at = _to_iso(_parse_iso_datetime(str(run_at), timezone_name))
    next_run_at = _compute_initial_next_run_at(
        kind=kind,
        run_at=run_at,
        interval_seconds=interval_seconds,
        timezone_name=timezone_name,
        now=now,
    )
    title = str(payload.get("title") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    if not title:
        raise ValueError("title is required")
    if not prompt:
        raise ValueError("prompt is required")

    enabled = bool(payload.get("enabled", True))
    schedule_id = f"sch-{uuid4().hex[:10]}"
    record: dict[str, Any] = {
        "schedule_id": schedule_id,
        "user_id": user_id,
        "title": title,
        "prompt": prompt,
        "kind": kind,
        "timezone": timezone_name,
        "run_at": run_at,
        "interval_seconds": interval_seconds,
        "enabled": enabled,
        "status": "active" if enabled else "paused",
        "next_run_at": next_run_at if enabled else None,
        "last_run_at": None,
        "last_run_id": None,
        "last_error": None,
        "cwd": payload.get("cwd"),
        "model": payload.get("model"),
        "effort": payload.get("effort"),
        "summary": payload.get("summary"),
        "output_schema": payload.get("output_schema"),
        "max_runtime_seconds": int(payload.get("max_runtime_seconds") or 1800),
        "created_at": _to_iso(now),
        "updated_at": _to_iso(now),
    }
    state = _read_state(config, user_id)
    state["schedules"][schedule_id] = record
    _write_state(config, user_id, state)
    return _copy_schedule(record)


def update_schedule(
    config: SandboxConfig,
    user_id: str,
    schedule_id: str,
    updates: dict[str, Any],
) -> dict[str, Any] | None:
    state = _read_state(config, user_id)
    record = state["schedules"].get(schedule_id)
    if not isinstance(record, dict):
        return None

    now = utc_now()
    timing_keys = {"kind", "timezone", "run_at", "interval_seconds"}
    timing_changed = any(key in updates for key in timing_keys)

    if "title" in updates and updates["title"] is not None:
        title = str(updates["title"]).strip()
        if not title:
            raise ValueError("title is required")
        record["title"] = title
    if "prompt" in updates and updates["prompt"] is not None:
        prompt = str(updates["prompt"]).strip()
        if not prompt:
            raise ValueError("prompt is required")
        record["prompt"] = prompt
    if "kind" in updates and updates["kind"] is not None:
        record["kind"] = _validate_kind(updates["kind"])
    if "timezone" in updates and updates["timezone"] is not None:
        record["timezone"] = _normalize_timezone(updates["timezone"])
    if "interval_seconds" in updates:
        record["interval_seconds"] = _interval_seconds(updates.get("interval_seconds"))
    if "run_at" in updates:
        run_at = updates.get("run_at")
        record["run_at"] = (
            _to_iso(_parse_iso_datetime(str(run_at), str(record.get("timezone") or "UTC"))) if run_at else None
        )

    for key in ("cwd", "model", "effort", "summary", "output_schema"):
        if key in updates:
            record[key] = updates[key]
    if "max_runtime_seconds" in updates and updates["max_runtime_seconds"] is not None:
        record["max_runtime_seconds"] = int(updates["max_runtime_seconds"])
    if "enabled" in updates and updates["enabled"] is not None:
        record["enabled"] = bool(updates["enabled"])

    if timing_changed or (record.get("enabled") and not record.get("next_run_at")):
        record["next_run_at"] = _compute_initial_next_run_at(
            kind=str(record.get("kind") or "once"),
            run_at=record.get("run_at"),
            interval_seconds=_interval_seconds(record.get("interval_seconds")),
            timezone_name=str(record.get("timezone") or "UTC"),
            now=now,
        )

    if record.get("enabled"):
        record["status"] = "active"
    elif record.get("status") != "completed":
        record["status"] = "paused"
        record["next_run_at"] = None
    record["last_error"] = None if record.get("status") == "active" else record.get("last_error")
    record["updated_at"] = _to_iso(now)
    state["schedules"][schedule_id] = record
    _write_state(config, user_id, state)
    return _copy_schedule(record)


def delete_schedule(config: SandboxConfig, user_id: str, schedule_id: str) -> bool:
    state = _read_state(config, user_id)
    if schedule_id not in state["schedules"]:
        return False
    del state["schedules"][schedule_id]
    _write_state(config, user_id, state)
    return True


def _run_records_for_schedule(config: SandboxConfig, user_id: str, schedule_id: str) -> list[dict[str, Any]]:
    records = list_user_job_records(config.sandbox_dir(user_id) / "agent-runs")
    return [record for record in records if record.get("schedule_id") == schedule_id]


def list_schedule_run_records(config: SandboxConfig, user_id: str, schedule_id: str) -> list[dict[str, Any]]:
    return _run_records_for_schedule(config, user_id, schedule_id)


def _start_codex_run_for_schedule(
    *,
    config: SandboxConfig,
    sandbox_manager: SandboxManager,
    agent_manager: ExternalAgentManager,
    user_id: str,
    record: dict[str, Any],
    trigger: str,
):
    max_runtime_seconds = int(record.get("max_runtime_seconds") or 1800)
    workspace_root = sandbox_manager.ensure_sandbox(user_id)
    assert_can_create_run(config, user_id, max_runtime_seconds)
    job = start_agent_run(
        prompt=str(record.get("prompt") or ""),
        input_items=None,
        model=record.get("model") if isinstance(record.get("model"), str) else None,
        effort=record.get("effort") if isinstance(record.get("effort"), str) else None,
        summary=record.get("summary") if isinstance(record.get("summary"), str) else None,
        output_schema=record.get("output_schema") if isinstance(record.get("output_schema"), dict) else None,
        provider_name="codex",
        raw_cwd=record.get("cwd") if isinstance(record.get("cwd"), str) else None,
        max_runtime_seconds=max_runtime_seconds,
        user_id=user_id,
        session_id=None,
        workspace_root=workspace_root,
        runtime_dir=config.sandbox_dir(user_id) / "agent-runs",
        manager=agent_manager,
        sandbox_config=config,
        require_agent_route=False,
    )
    job.metadata.update(
        {
            "schedule_id": record.get("schedule_id"),
            "schedule_title": record.get("title"),
            "schedule_trigger": trigger,
        }
    )
    write_job_meta(job)
    return job


def trigger_schedule_now(
    *,
    config: SandboxConfig,
    sandbox_manager: SandboxManager,
    agent_manager: ExternalAgentManager,
    user_id: str,
    schedule_id: str,
):
    state = _read_state(config, user_id)
    record = state["schedules"].get(schedule_id)
    if not isinstance(record, dict):
        return None

    now = utc_now()
    try:
        job = _start_codex_run_for_schedule(
            config=config,
            sandbox_manager=sandbox_manager,
            agent_manager=agent_manager,
            user_id=user_id,
            record=record,
            trigger="manual",
        )
    except Exception as exc:
        record["status"] = "error"
        record["last_error"] = str(exc)
        record["updated_at"] = _to_iso(now)
        state["schedules"][schedule_id] = record
        _write_state(config, user_id, state)
        raise

    record["last_run_at"] = _to_iso(now)
    record["last_run_id"] = job.job_id
    record["last_error"] = None
    if record.get("enabled") and record.get("status") != "completed":
        record["status"] = "active"
    record["updated_at"] = _to_iso(now)
    state["schedules"][schedule_id] = record
    _write_state(config, user_id, state)
    return job


async def trigger_due_schedules(
    *,
    config: SandboxConfig,
    sandbox_manager: SandboxManager,
    agent_manager: ExternalAgentManager,
    user_id: str,
    now: datetime | None = None,
) -> list[str]:
    now = now or utc_now()
    triggered: list[str] = []
    state = _read_state(config, user_id)
    changed = False

    for schedule_id, record in list(state["schedules"].items()):
        if not isinstance(record, dict):
            continue
        if not record.get("enabled") or record.get("status") not in {"active"}:
            continue
        next_run_at = _parse_iso_datetime(str(record.get("next_run_at") or ""), str(record.get("timezone") or "UTC"))
        if next_run_at is None or next_run_at > now:
            continue

        try:
            job = _start_codex_run_for_schedule(
                config=config,
                sandbox_manager=sandbox_manager,
                agent_manager=agent_manager,
                user_id=user_id,
                record=record,
                trigger="scheduled",
            )
        except Exception as exc:
            logger.warning("schedule {} failed to start: {}", schedule_id, exc)
            record["status"] = "error"
            record["enabled"] = False
            record["next_run_at"] = None
            record["last_error"] = str(exc)
            record["updated_at"] = _to_iso(now)
            state["schedules"][schedule_id] = record
            changed = True
            continue

        record["last_run_at"] = _to_iso(now)
        record["last_run_id"] = job.job_id
        record["last_error"] = None
        if record.get("kind") == "once":
            record["enabled"] = False
            record["status"] = "completed"
            record["next_run_at"] = None
        else:
            record["status"] = "active"
            record["next_run_at"] = _advance_next_run_at(record, now)
        record["updated_at"] = _to_iso(now)
        state["schedules"][schedule_id] = record
        triggered.append(schedule_id)
        changed = True

    if changed:
        _write_state(config, user_id, state)
    return triggered


class ScheduleTriggerService:
    """Polls schedule metadata and starts due Codex runs."""

    def __init__(
        self,
        *,
        sandbox_manager: SandboxManager,
        agent_manager: ExternalAgentManager,
        poll_interval_seconds: float = 15.0,
    ):
        self.sandbox_manager = sandbox_manager
        self.agent_manager = agent_manager
        self.poll_interval_seconds = poll_interval_seconds
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._trigger_lock = asyncio.Lock()

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._loop(), name="ripple-schedule-trigger")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def run_once(self) -> dict[str, list[str]]:
        async with self._trigger_lock:
            triggered: dict[str, list[str]] = {}
            for user_id in self.sandbox_manager.list_user_sandboxes():
                schedule_ids = await trigger_due_schedules(
                    config=self.sandbox_manager.config,
                    sandbox_manager=self.sandbox_manager,
                    agent_manager=self.agent_manager,
                    user_id=user_id,
                )
                if schedule_ids:
                    triggered[user_id] = schedule_ids
            return triggered

    async def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("schedule trigger pass failed: {}", exc)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.poll_interval_seconds)
            except TimeoutError:
                continue
