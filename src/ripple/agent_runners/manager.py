"""In-memory external agent job manager."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from ripple.agent_runners.codex_app_server import CodexAppServerAgentProvider
from ripple.agent_runners.job_store import write_job_meta
from ripple.agent_runners.models import AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AgentProvider(Protocol):
    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult: ...


@dataclass
class ExternalAgentJob:
    job_id: str
    provider: str
    prompt: str
    cwd: Path
    user_id: str | None = None
    session_id: str | None = None
    metadata: dict = field(default_factory=dict)
    status: AgentRunnerStatus = AgentRunnerStatus.QUEUED
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)
    events_file: Path | None = None
    output_file: Path | None = None
    exit_code: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: str | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    def apply_result(self, result: AgentRunnerResult) -> None:
        self.status = result.status
        self.updated_at = _now()
        self.events_file = result.events_file
        self.output_file = result.output_file
        self.exit_code = result.exit_code
        self.stdout_tail = result.stdout_tail
        self.stderr_tail = result.stderr_tail
        self.error = result.error

    def to_result(self) -> AgentRunnerResult | None:
        if self.events_file is None:
            return None
        return AgentRunnerResult(
            job_id=self.job_id,
            provider=self.provider,
            status=self.status,
            events_file=self.events_file,
            output_file=self.output_file,
            exit_code=self.exit_code,
            stdout_tail=self.stdout_tail,
            stderr_tail=self.stderr_tail,
            error=self.error,
        )


class ExternalAgentManager:
    def __init__(self, providers: dict[str, AgentProvider] | None = None):
        self.providers = providers or {}
        self.jobs: dict[str, ExternalAgentJob] = {}

    def has_provider(self, provider: str) -> bool:
        return provider in self.providers

    def start(self, request: AgentRunnerRequest, *, runtime_dir: Path) -> ExternalAgentJob:
        provider = self.providers.get(request.provider)
        if provider is None:
            raise KeyError(f"external agent provider '{request.provider}' is not configured")

        job_id = request.job_id or f"agent-{uuid4().hex[:8]}"
        request = request.model_copy(update={"job_id": job_id})
        job_dir = runtime_dir / "external-agents" / job_id
        job = ExternalAgentJob(
            job_id=job_id,
            provider=request.provider,
            prompt=request.prompt,
            cwd=request.cwd,
            user_id=request.user_id,
            session_id=request.session_id,
            metadata=request.metadata,
            status=AgentRunnerStatus.RUNNING,
            events_file=job_dir / "events.jsonl",
            output_file=job_dir / "output.txt",
        )
        self.jobs[job_id] = job
        write_job_meta(job)
        job.task = asyncio.create_task(self._run_job(job, provider, request, job_dir))
        return job

    def get(self, job_id: str) -> ExternalAgentJob | None:
        return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.task is None or job.task.done():
            return False
        job.task.cancel()
        return True

    def steer(self, job_id: str, text: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.status != AgentRunnerStatus.RUNNING:
            return False
        provider = self.providers.get(job.provider)
        steer = getattr(provider, "steer", None)
        if not callable(steer):
            return False
        return bool(steer(job_id, text))

    def get_pending_approval(self, job_id: str) -> dict | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        provider = self.providers.get(job.provider)
        get_pending = getattr(provider, "get_pending_approval", None)
        if not callable(get_pending):
            return None
        return get_pending(job_id)

    async def wait_for_pending_approval(self, job_id: str, *, timeout: float) -> dict:
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(f"agent run not found: {job_id}")
        provider = self.providers.get(job.provider)
        wait_for_pending = getattr(provider, "wait_for_pending_approval", None)
        if not callable(wait_for_pending):
            raise RuntimeError(f"provider '{job.provider}' does not support approval waiting")
        return await wait_for_pending(job_id, timeout=timeout)

    def resolve_approval(self, job_id: str, request_id: object, action: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None:
            return False
        provider = self.providers.get(job.provider)
        resolve = getattr(provider, "resolve_approval", None)
        if not callable(resolve):
            return False
        return bool(resolve(job_id, request_id, action))

    async def stop_user(self, user_id: str) -> None:
        tasks = []
        for job in self.jobs.values():
            if job.user_id == user_id and job.status == AgentRunnerStatus.RUNNING and job.task is not None:
                if not job.task.done():
                    job.task.cancel()
                    tasks.append(job.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for provider in self.providers.values():
            stop_user = getattr(provider, "stop_user", None)
            if callable(stop_user):
                await stop_user(user_id)

    async def stop_all(self) -> None:
        tasks = []
        for job in self.jobs.values():
            if job.status == AgentRunnerStatus.RUNNING and job.task is not None and not job.task.done():
                job.task.cancel()
                tasks.append(job.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for provider in self.providers.values():
            stop_all = getattr(provider, "stop_all", None)
            if callable(stop_all):
                await stop_all()

    async def wait(self, job_id: str) -> AgentRunnerResult | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        if job.task is not None:
            try:
                await job.task
            except asyncio.CancelledError:
                job.status = AgentRunnerStatus.CANCELLED
                job.error = "runner cancelled"
                job.updated_at = _now()
        return job.to_result()

    async def _run_job(
        self,
        job: ExternalAgentJob,
        provider: AgentProvider,
        request: AgentRunnerRequest,
        job_dir: Path,
    ) -> None:
        try:
            result = await provider.run(request, job_dir=job_dir)
        except asyncio.CancelledError:
            job.status = AgentRunnerStatus.CANCELLED
            job.error = "runner cancelled"
            job.updated_at = _now()
            write_job_meta(job)
            return
        except Exception as exc:  # noqa: BLE001
            job.status = AgentRunnerStatus.FAILED
            job.error = str(exc)
            job.updated_at = _now()
            write_job_meta(job)
            return
        job.apply_result(result)
        write_job_meta(job)


def build_external_agent_manager_from_config() -> ExternalAgentManager:
    from ripple.utils.config import get_config

    config = get_config()
    codex_config = config.get("external_agents.codex", {}) or {}
    providers: dict[str, AgentProvider] = {}
    if isinstance(codex_config, dict) and codex_config.get("enabled", True):
        app_server_args = codex_config.get("app_server_args")
        codex_home = codex_config.get("codex_home")
        providers["codex"] = CodexAppServerAgentProvider(
            codex_executable=str(codex_config.get("codex_executable") or "codex"),
            app_server_args=list(app_server_args)
            if isinstance(app_server_args, list)
            else ["app-server", "--listen", "stdio://"],
            approval_policy=str(codex_config.get("approval_policy") or "never"),
            sandbox_type=str(codex_config.get("sandbox_type") or "workspace-write"),
            network_access=bool(codex_config.get("network_access", True)),
            codex_home=Path(str(codex_home)).expanduser() if codex_home else None,
            env=codex_config.get("env") if isinstance(codex_config.get("env"), dict) else None,
            idle_timeout_seconds=int(codex_config.get("idle_timeout_seconds") or 1800),
            run_app_server_in_user_sandbox=bool(codex_config.get("run_app_server_in_user_sandbox", False)),
            ephemeral_threads=bool(codex_config.get("ephemeral_threads", True)),
            request_timeout_seconds=float(codex_config.get("request_timeout_seconds") or 30.0),
        )
    return ExternalAgentManager(providers=providers)


_global_external_agent_manager: ExternalAgentManager | None = None


def get_external_agent_manager() -> ExternalAgentManager:
    global _global_external_agent_manager
    if _global_external_agent_manager is None:
        _global_external_agent_manager = build_external_agent_manager_from_config()
    return _global_external_agent_manager
