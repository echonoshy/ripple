"""Models for user-scoped scheduled sandbox jobs."""

from datetime import datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from ripple.utils.time import utc_now

ScheduleType = Literal["once", "interval"]
ExecutionType = Literal["command", "agent"]
JobStatus = Literal["enabled", "disabled"]
RunStatus = Literal["running", "success", "failed", "timeout", "skipped", "cancelled"]
ConcurrencyPolicy = Literal["skip"]
CreatedFrom = Literal["chat", "ui", "api"]


def new_job_id() -> str:
    return f"job-{uuid4().hex[:12]}"


def new_run_id() -> str:
    return f"run-{uuid4().hex[:12]}"


class ScheduledJob(BaseModel):
    id: str = Field(default_factory=new_job_id)
    user_id: str
    name: str
    command: str = ""
    prompt: str | None = None
    execution_type: ExecutionType = "command"
    created_from: CreatedFrom = "api"
    schedule_type: ScheduleType
    run_at: datetime | None = None
    interval_seconds: int | None = None
    max_runs: int | None = Field(default=None, ge=1)
    enabled: bool = True
    timeout_seconds: int = 300
    concurrency_policy: ConcurrencyPolicy = "skip"
    next_run_at: datetime | None = None
    running_at: datetime | None = None
    current_run_id: str | None = None
    last_run_at: datetime | None = None
    last_status: RunStatus | None = None
    last_error: str | None = None
    last_duration_ms: int | None = None
    run_count: int = 0
    consecutive_errors: int = 0
    consecutive_skipped: int = 0
    schedule_error_count: int = 0
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ScheduledJobState(BaseModel):
    job_id: str
    next_run_at: datetime | None = None
    running_at: datetime | None = None
    current_run_id: str | None = None
    last_run_at: datetime | None = None
    last_status: RunStatus | None = None
    last_error: str | None = None
    last_duration_ms: int | None = None
    run_count: int = 0
    consecutive_errors: int = 0
    consecutive_skipped: int = 0
    schedule_error_count: int = 0
    updated_at: datetime = Field(default_factory=utc_now)


class ScheduledRun(BaseModel):
    id: str = Field(default_factory=new_run_id)
    job_id: str
    user_id: str
    status: RunStatus = "running"
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: datetime | None = None
    exit_code: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: str | None = None
    summary: str | None = None
    duration_ms: int | None = None
