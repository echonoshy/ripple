"""Time helpers for user-facing runtime context."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TIMEZONE = "Asia/Shanghai"


def _configured_timezone_name_raw() -> str:
    try:
        from ripple.utils.config import get_config

        value = get_config().get("server.timezone", DEFAULT_TIMEZONE)
    except Exception:
        return DEFAULT_TIMEZONE

    if not isinstance(value, str) or not value.strip():
        return DEFAULT_TIMEZONE
    return value.strip()


def configured_timezone_name() -> str:
    """Return the configured user-facing timezone name."""
    name = _configured_timezone_name_raw()
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return DEFAULT_TIMEZONE
    return name


def configured_timezone() -> ZoneInfo:
    """Return the configured timezone, falling back to Asia/Shanghai."""
    return ZoneInfo(configured_timezone_name())


def local_now() -> datetime:
    """Current time in the configured user-facing timezone."""
    return datetime.now(configured_timezone())


def utc_now() -> datetime:
    """Current UTC time."""
    return datetime.now(timezone.utc)


def to_utc(value: datetime) -> datetime:
    """Convert a datetime to UTC.

    Naive datetimes are interpreted in the configured user-facing timezone,
    matching HTML datetime-local values and model-generated local timestamps.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=configured_timezone())
    return value.astimezone(timezone.utc)


def current_time_context() -> str:
    """A compact prompt fragment describing the current local and UTC time."""
    now_local = local_now()
    now_utc = now_local.astimezone(timezone.utc)
    local_offset = now_local.strftime("%z")
    formatted_offset = f"{local_offset[:3]}:{local_offset[3:]}" if local_offset else ""
    return (
        f"Current local time is {now_local.strftime('%Y-%m-%d %H:%M:%S')} "
        f"({configured_timezone_name()}, UTC{formatted_offset}). "
        f"Today's local date is {now_local.strftime('%Y/%m/%d')}. "
        f"Current UTC time is {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC. "
        "Use the local time for user-facing answers, relative time requests, and scheduling unless the user "
        "explicitly asks for another timezone."
    )
