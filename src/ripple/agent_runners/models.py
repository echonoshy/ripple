"""Shared models for external agent runners."""

from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentRunnerStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AgentRunnerRequest(BaseModel):
    provider: str
    prompt: str
    cwd: Path
    input_items: list[dict[str, Any]] = Field(default_factory=list)
    model: str | None = None
    effort: str | None = None
    summary: str | None = None
    output_schema: dict[str, Any] | None = None
    job_id: str | None = None
    max_runtime_seconds: int = Field(default=1800, ge=1, le=86_400)
    user_id: str | None = None
    session_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentRunnerEvent(BaseModel):
    type: str
    job_id: str
    provider: str
    sequence: int | None = None
    message: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=utc_now_iso)


class AgentRunnerResult(BaseModel):
    job_id: str
    provider: str
    status: AgentRunnerStatus
    events_file: Path
    output_file: Path | None = None
    exit_code: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
