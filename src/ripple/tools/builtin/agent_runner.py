"""Tool for launching server-side external agent runners."""

from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, Field

from ripple.agent_runners.manager import ExternalAgentManager, get_external_agent_manager
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerStatus
from ripple.agent_runners.router import ExecutionRoute, choose_route
from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult


class AgentRunnerInput(BaseModel):
    action: Literal["start", "status", "cancel", "steer"] = Field(default="start")
    prompt: str | None = Field(
        default=None, description="Complex task prompt when action=start or message when action=steer"
    )
    provider: str = Field(default="auto", description="auto or codex")
    job_id: str | None = Field(default=None, description="External agent job id for status/cancel")
    cwd: str | None = Field(default=None, description="Workspace-relative directory for the runner")
    max_runtime_seconds: int = Field(default=1800, ge=1, le=86_400)


class AgentRunnerOutput(BaseModel):
    status: str
    message: str
    job_id: str | None = None
    provider: str | None = None
    route: str | None = None
    output_file: str | None = None
    events_file: str | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""


class AgentRunnerTool(Tool[AgentRunnerInput, AgentRunnerOutput]):
    def __init__(self, manager: ExternalAgentManager | None = None):
        self.name = "AgentRunner"
        self.description = (
            "Launch, inspect, or cancel a trusted server-side Codex app-server agent. "
            "Use for complex non-trivial work that should run inside the current user's sandbox, "
            "including repository analysis, multi-file changes, debugging, long-running file work, "
            "or complex tasks that need progress streaming and cancellation."
        )
        self.max_result_size_chars = 40_000
        self.risk_level = ToolRiskLevel.MODERATE
        self._manager = manager

    async def call(
        self,
        args: AgentRunnerInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[AgentRunnerOutput]:
        if isinstance(args, dict):
            args = AgentRunnerInput(**args)

        if args.action == "start":
            return self._start(args, context)
        if args.action == "status":
            return self._status(args)
        if args.action == "cancel":
            return await self._cancel(args)
        if args.action == "steer":
            return self._steer(args)
        return ToolResult(data=AgentRunnerOutput(status="error", message=f"unsupported action: {args.action}"))

    def _manager_or_default(self) -> ExternalAgentManager:
        return self._manager or get_external_agent_manager()

    def _start(self, args: AgentRunnerInput, context: ToolUseContext) -> ToolResult[AgentRunnerOutput]:
        prompt = (args.prompt or "").strip()
        if not prompt:
            return ToolResult(data=AgentRunnerOutput(status="error", message="prompt is required for start"))

        explicit_provider = None if args.provider == "auto" else args.provider
        if explicit_provider is not None and explicit_provider != "codex":
            return ToolResult(
                data=AgentRunnerOutput(
                    status="error",
                    message="Only the codex provider is supported in this version",
                    provider=explicit_provider,
                )
            )
        decision = choose_route(prompt, explicit_provider=explicit_provider)
        if explicit_provider is None and decision.route != ExecutionRoute.AGENT_RUNNER:
            return ToolResult(
                data=AgentRunnerOutput(
                    status="not_routed",
                    message=decision.reason,
                    route=decision.route.value,
                )
            )
        provider = decision.provider or "codex"
        manager = self._manager_or_default()
        if not manager.has_provider(provider):
            return ToolResult(
                data=AgentRunnerOutput(
                    status="error",
                    message=f"external agent provider '{provider}' is not configured",
                    provider=provider,
                    route=decision.route.value,
                )
            )

        cwd = self._resolve_cwd(args.cwd, context)
        runtime_dir = context.session_runtime_dir or (context.cwd / ".ripple")
        runtime_dir.mkdir(parents=True, exist_ok=True)
        metadata: dict[str, Any] = {"route": decision.route.value, "signals": decision.signals}
        if context.is_sandboxed and context.workspace_root is not None:
            relative_cwd = cwd.relative_to(context.workspace_root.resolve())
            metadata["sandbox_cwd"] = PurePosixPath("/workspace", *relative_cwd.parts).as_posix()
            if context.sandbox_manager is not None:
                metadata["sandbox_config"] = context.sandbox_manager.config
        job = manager.start(
            AgentRunnerRequest(
                provider=provider,
                prompt=prompt,
                cwd=cwd,
                max_runtime_seconds=args.max_runtime_seconds,
                user_id=context.user_id,
                session_id=context.session_id,
                metadata=metadata,
            ),
            runtime_dir=runtime_dir,
        )
        return ToolResult(
            data=AgentRunnerOutput(
                status="started",
                message=decision.reason,
                job_id=job.job_id,
                provider=provider,
                route=decision.route.value,
                output_file=str(job.output_file) if job.output_file else None,
                events_file=str(job.events_file) if job.events_file else None,
            )
        )

    def _status(self, args: AgentRunnerInput) -> ToolResult[AgentRunnerOutput]:
        if not args.job_id:
            return ToolResult(data=AgentRunnerOutput(status="error", message="job_id is required for status"))
        job = self._manager_or_default().get(args.job_id)
        if job is None:
            return ToolResult(data=AgentRunnerOutput(status="error", message=f"job not found: {args.job_id}"))
        return ToolResult(data=self._output_from_job(job, message="job status"))

    async def _cancel(self, args: AgentRunnerInput) -> ToolResult[AgentRunnerOutput]:
        if not args.job_id:
            return ToolResult(data=AgentRunnerOutput(status="error", message="job_id is required for cancel"))
        manager = self._manager_or_default()
        job = manager.get(args.job_id)
        if job is None:
            return ToolResult(data=AgentRunnerOutput(status="error", message=f"job not found: {args.job_id}"))
        if job.status in {AgentRunnerStatus.COMPLETED, AgentRunnerStatus.FAILED, AgentRunnerStatus.CANCELLED}:
            return ToolResult(data=self._output_from_job(job, message="job already finished"))
        if manager.cancel(args.job_id):
            await manager.wait(args.job_id)
        refreshed = manager.get(args.job_id) or job
        return ToolResult(data=self._output_from_job(refreshed, message="cancel requested"))

    def _steer(self, args: AgentRunnerInput) -> ToolResult[AgentRunnerOutput]:
        if not args.job_id:
            return ToolResult(data=AgentRunnerOutput(status="error", message="job_id is required for steer"))
        text = (args.prompt or "").strip()
        if not text:
            return ToolResult(data=AgentRunnerOutput(status="error", message="prompt is required for steer"))
        manager = self._manager_or_default()
        job = manager.get(args.job_id)
        if job is None:
            return ToolResult(data=AgentRunnerOutput(status="error", message=f"job not found: {args.job_id}"))
        if manager.steer(args.job_id, text):
            return ToolResult(
                data=AgentRunnerOutput(
                    status="steered",
                    message="user input forwarded to running agent",
                    job_id=job.job_id,
                    provider=job.provider,
                    output_file=str(job.output_file) if job.output_file else None,
                    events_file=str(job.events_file) if job.events_file else None,
                    stdout_tail=job.stdout_tail,
                    stderr_tail=job.stderr_tail,
                )
            )
        return ToolResult(
            data=AgentRunnerOutput(
                status="error",
                message="job is not running or provider does not support steering",
                job_id=args.job_id,
                provider=job.provider,
            )
        )

    def _resolve_cwd(self, raw_cwd: str | None, context: ToolUseContext) -> Path:
        root = (context.workspace_root or context.cwd).resolve()
        if raw_cwd:
            candidate = Path(raw_cwd)
            if not candidate.is_absolute():
                candidate = root / candidate
            candidate = candidate.resolve()
        else:
            candidate = root
        if not candidate.is_relative_to(root):
            raise ValueError("cwd must stay inside the user workspace")
        return candidate

    def _output_from_job(self, job, *, message: str) -> AgentRunnerOutput:
        return AgentRunnerOutput(
            status=job.status.value,
            message=message,
            job_id=job.job_id,
            provider=job.provider,
            output_file=str(job.output_file) if job.output_file else None,
            events_file=str(job.events_file) if job.events_file else None,
            stdout_tail=job.stdout_tail,
            stderr_tail=job.stderr_tail,
        )

    def requires_confirmation(self, input_params: dict) -> bool:
        return input_params.get("action", "start") == "start"

    def is_concurrency_safe(self, input: AgentRunnerInput | dict[str, Any]) -> bool:
        return True

    def _get_parameters_schema(self) -> dict[str, Any]:
        return AgentRunnerInput.model_json_schema()
