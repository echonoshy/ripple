"""Schedule tool for user-scoped scheduled jobs."""

from datetime import datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.scheduler.manager import ScheduledJobRunningError, SchedulerManager
from ripple.scheduler.models import ScheduledJob, utc_now
from ripple.tools.base import Tool, ToolResult

_scheduler_manager: SchedulerManager | None = None


def set_schedule_tool_manager(manager: SchedulerManager) -> None:
    global _scheduler_manager
    _scheduler_manager = manager


class ScheduleToolInput(BaseModel):
    action: Literal["status", "list", "add", "update", "remove", "run", "runs"]
    job_id: str | None = Field(default=None, description="Scheduled job id for update/remove/run/runs")
    name: str | None = Field(default=None, description="Job name for add/update")
    execution_type: Literal["command", "agent"] = Field(
        default="agent",
        description="agent runs a scheduled agent turn; command runs a sandbox shell command",
    )
    command: str | None = Field(default=None, description="Sandbox command for command jobs")
    prompt: str | None = Field(default=None, description="Agent prompt for agent jobs")
    schedule_type: Literal["once", "interval"] = "once"
    run_at: str | None = Field(default=None, description="ISO-8601 timestamp for one-shot jobs")
    delay_seconds: int | None = Field(default=None, ge=1, description="Relative delay for one-shot jobs")
    interval_seconds: int | None = Field(default=None, ge=1, description="Interval in seconds for recurring jobs")
    max_runs: int | None = Field(default=None, ge=1, description="Stop interval jobs after this many actual runs")
    enabled: bool | None = None
    timeout_seconds: int | None = Field(default=None, ge=1, le=86_400)
    limit: int | None = Field(default=20, ge=1, le=200)


class ScheduleToolOutput(BaseModel):
    action: str
    status: str = "ok"
    job: dict[str, Any] | None = None
    jobs: list[dict[str, Any]] | None = None
    run: dict[str, Any] | None = None
    runs: list[dict[str, Any]] | None = None
    count: int | None = None
    message: str | None = None


class ScheduleTool(Tool[ScheduleToolInput, ScheduleToolOutput]):
    def __init__(self):
        self.name = "Schedule"
        self.description = (
            "Create and manage persistent scheduled jobs. Use this for reminders, delayed follow-ups, "
            "run-later work, and recurring tasks. Do not emulate scheduling with Bash sleep, at, cron, "
            "timeout loops, or polling. Prefer execution_type='agent' for user requests expressed in chat; "
            "use execution_type='command' only when the user specifically wants a shell command."
        )
        self.max_result_size_chars = 100_000

    def _manager(self) -> SchedulerManager:
        if _scheduler_manager is None:
            raise RuntimeError("Schedule manager is not configured")
        return _scheduler_manager

    async def call(
        self,
        args: ScheduleToolInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[ScheduleToolOutput]:
        if isinstance(args, dict):
            args = ScheduleToolInput(**args)
        manager = self._manager()
        user_id = context.user_id or "default"

        if args.action == "status":
            jobs = manager.list_jobs(user_id)
            return ToolResult(
                data=ScheduleToolOutput(
                    action=args.action,
                    count=len(jobs),
                    message="scheduler is configured",
                )
            )

        if args.action == "list":
            jobs = [job.model_dump(mode="json") for job in manager.list_jobs(user_id)]
            return ToolResult(data=ScheduleToolOutput(action=args.action, jobs=jobs, count=len(jobs)))

        if args.action == "add":
            job = self._build_job(args, user_id)
            created = manager.create_job(job)
            return ToolResult(
                data=ScheduleToolOutput(
                    action=args.action,
                    job=created.model_dump(mode="json"),
                    message=f"scheduled job {created.id} next runs at {created.next_run_at}",
                )
            )

        if args.action == "update":
            job = self._get_job_or_raise(manager, user_id, args.job_id)
            update = args.model_dump(exclude_unset=True)
            for key in (
                "name",
                "execution_type",
                "command",
                "prompt",
                "schedule_type",
                "interval_seconds",
                "max_runs",
                "enabled",
                "timeout_seconds",
            ):
                if key in update and update[key] is not None:
                    setattr(job, key, update[key])
            if "run_at" in update or "delay_seconds" in update:
                job.run_at = self._resolve_run_at(job.schedule_type, args)
            self._validate_job_fields(job)
            updated = manager.update_job(job)
            return ToolResult(data=ScheduleToolOutput(action=args.action, job=updated.model_dump(mode="json")))

        if args.action == "remove":
            job_id = self._require_job_id(args.job_id)
            try:
                removed = manager.delete_job(user_id, job_id)
            except ScheduledJobRunningError as exc:
                return ToolResult(
                    data=ScheduleToolOutput(
                        action=args.action,
                        status="running",
                        message=str(exc),
                    )
                )
            return ToolResult(
                data=ScheduleToolOutput(
                    action=args.action,
                    status="ok" if removed else "not_found",
                    message=f"removed {job_id}" if removed else f"job not found: {job_id}",
                )
            )

        if args.action == "run":
            job_id = self._require_job_id(args.job_id)
            run = await manager.run_job(user_id, job_id)
            return ToolResult(
                data=ScheduleToolOutput(
                    action=args.action,
                    status="ok" if run else "not_found",
                    run=run.model_dump(mode="json") if run else None,
                )
            )

        if args.action == "runs":
            job_id = self._require_job_id(args.job_id)
            runs = [run.model_dump(mode="json") for run in manager.list_runs(user_id, job_id, limit=args.limit or 20)]
            return ToolResult(data=ScheduleToolOutput(action=args.action, runs=runs, count=len(runs)))

        return ToolResult(data=ScheduleToolOutput(action=args.action, status="error", message="unknown action"))

    def _build_job(self, args: ScheduleToolInput, user_id: str) -> ScheduledJob:
        name = (args.name or "").strip()
        if not name:
            raise ValueError("name is required")
        run_at = self._resolve_run_at(args.schedule_type, args)
        command = (args.command or "").strip()
        prompt = (args.prompt or "").strip()
        if args.execution_type == "command" and not command:
            raise ValueError("command is required for command schedules")
        if args.execution_type == "agent" and not prompt:
            raise ValueError("prompt is required for agent schedules")
        if args.schedule_type == "interval" and not args.interval_seconds:
            raise ValueError("interval_seconds is required for interval schedules")
        return ScheduledJob(
            user_id=user_id,
            name=name,
            command=command,
            prompt=prompt or None,
            execution_type=args.execution_type,
            created_from="chat",
            schedule_type=args.schedule_type,
            run_at=run_at,
            interval_seconds=args.interval_seconds,
            max_runs=args.max_runs,
            enabled=True if args.enabled is None else args.enabled,
            timeout_seconds=args.timeout_seconds or 300,
        )

    def _resolve_run_at(self, schedule_type: str, args: ScheduleToolInput):
        if schedule_type != "once":
            return None
        if args.delay_seconds:
            return utc_now() + timedelta(seconds=args.delay_seconds)
        if args.run_at:
            return datetime.fromisoformat(args.run_at.replace("Z", "+00:00"))
        raise ValueError("run_at or delay_seconds is required for once schedules")

    def _get_job_or_raise(self, manager: SchedulerManager, user_id: str, job_id: str | None) -> ScheduledJob:
        resolved = self._require_job_id(job_id)
        job = manager.get_job(user_id, resolved)
        if job is None:
            raise ValueError(f"job not found: {resolved}")
        return job

    def _require_job_id(self, job_id: str | None) -> str:
        resolved = (job_id or "").strip()
        if not resolved:
            raise ValueError("job_id is required")
        return resolved

    def _validate_job_fields(self, job: ScheduledJob) -> None:
        if not job.name.strip():
            raise ValueError("name is required")
        if job.schedule_type == "once" and job.run_at is None:
            raise ValueError("run_at or delay_seconds is required for once schedules")
        if job.schedule_type == "interval" and not job.interval_seconds:
            raise ValueError("interval_seconds is required for interval schedules")
        if job.execution_type == "command" and not job.command.strip():
            raise ValueError("command is required for command schedules")
        if job.execution_type == "agent" and not (job.prompt or "").strip():
            raise ValueError("prompt is required for agent schedules")

    def is_concurrency_safe(self, input: ScheduleToolInput | dict[str, Any]) -> bool:
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        return ScheduleToolInput.model_json_schema()
