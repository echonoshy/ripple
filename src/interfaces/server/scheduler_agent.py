"""Codex runner used by scheduled agent jobs."""

from ripple.agent_runners.manager import get_external_agent_manager
from ripple.agent_runners.models import AgentRunnerResult, AgentRunnerStatus
from ripple.agent_runners.service import start_agent_run
from ripple.sandbox.manager import SandboxManager
from ripple.scheduler.models import ScheduledJob, ScheduledRun
from ripple.utils.logger import get_logger

logger = get_logger("server.scheduler_agent")


def _scheduled_codex_prompt(job: ScheduledJob) -> str:
    return (
        "You are Codex, running a scheduled Ripple job inside the current user's sandbox.\n"
        "Ripple owns scheduling, user isolation, sandbox lifecycle, connector state, and persistence. "
        "Do the requested work in /workspace and return a concise final summary.\n\n"
        "## Scheduled Job\n"
        f"- job_id: {job.id}\n"
        f"- job_name: {job.name}\n"
        f"- user_id: {job.user_id}\n"
        "- workspace: /workspace\n\n"
        "## Job Prompt\n"
        f"{(job.prompt or '').strip()}\n"
    )


def _read_output(result: AgentRunnerResult | None) -> str:
    if result is None:
        return ""
    if result.output_file and result.output_file.exists():
        return result.output_file.read_text(encoding="utf-8")
    return result.stdout_tail or ""


async def run_scheduled_agent_job(
    job: ScheduledJob,
    run: ScheduledRun,
    sandbox_manager: SandboxManager,
) -> ScheduledRun:
    """Run a scheduled prompt through the per-user Codex execution plane."""

    if not (job.prompt or "").strip():
        run.status = "failed"
        run.error = "agent schedule prompt is empty"
        return run

    sandbox_manager.ensure_sandbox(job.user_id)
    workspace_root = sandbox_manager.config.workspace_dir(job.user_id)
    runtime_dir = sandbox_manager.config.scheduled_runs_dir(job.user_id) / job.id / run.id / "agent-run"
    prompt = _scheduled_codex_prompt(job)
    agent_manager = get_external_agent_manager()

    try:
        agent_job = start_agent_run(
            prompt=prompt,
            provider_name="codex",
            raw_cwd="/workspace",
            max_runtime_seconds=job.timeout_seconds,
            user_id=job.user_id,
            session_id=None,
            workspace_root=workspace_root,
            runtime_dir=runtime_dir,
            manager=agent_manager,
            sandbox_config=sandbox_manager.config,
            require_agent_route=False,
        )
        result = await agent_manager.wait(agent_job.job_id)
        final_text = _read_output(result)
        run.summary = final_text
        run.stdout_tail = final_text[-64_000:]
        run.stderr_tail = result.stderr_tail[-64_000:] if result else ""
        run.exit_code = result.exit_code if result and result.exit_code is not None else 0

        if result is not None and result.status == AgentRunnerStatus.COMPLETED:
            run.status = "success"
            return run

        run.status = "failed"
        run.error = result.error if result and result.error else "scheduled Codex run failed"
    except Exception as exc:
        logger.exception("定时 Codex 任务异常: job={} run={} error={}", job.id, run.id, exc)
        run.status = "failed"
        run.error = str(exc)

    return run
