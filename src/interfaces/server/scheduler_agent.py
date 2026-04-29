"""Agent runner used by scheduled jobs."""

from uuid import uuid4

from interfaces.server.sessions import _create_session_context, _merge_system_prompt
from ripple.core.agent_loop import query
from ripple.messages.types import AgentStopEvent, AssistantMessage
from ripple.sandbox.manager import SandboxManager
from ripple.scheduler.models import ScheduledJob, ScheduledRun
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

logger = get_logger("server.scheduler_agent")


def _assistant_text(message: AssistantMessage) -> str:
    parts = []
    for block in message.message.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text)
    return "\n".join(parts).strip()


async def run_scheduled_agent_job(
    job: ScheduledJob,
    run: ScheduledRun,
    sandbox_manager: SandboxManager,
) -> ScheduledRun:
    """Run an agent prompt for a scheduled job and store the result on the run record."""

    prompt = (job.prompt or "").strip()
    if not prompt:
        run.status = "failed"
        run.error = "agent schedule prompt is empty"
        return run

    config = get_config()
    model = config.resolve_model(config.get("model.default", "sonnet"))
    internal_session_id = f"sched-{uuid4().hex[:12]}"

    sandbox_manager.ensure_sandbox(job.user_id)
    workspace_root = sandbox_manager.config.workspace_dir(job.user_id)
    session_runtime_dir = sandbox_manager.config.scheduled_runs_dir(job.user_id) / job.id / run.id / "runtime"
    session_runtime_dir.mkdir(parents=True, exist_ok=True)

    context, client = _create_session_context(
        model,
        internal_session_id,
        workspace_root=workspace_root,
        sandbox_session_id=None,
        session_runtime_dir=session_runtime_dir,
        user_id=job.user_id,
        sandbox_manager=sandbox_manager,
    )
    system_prompt = _merge_system_prompt(workspace_root, None)

    final_text = ""
    stop_reason = ""
    try:
        async for item in query(
            prompt,
            context,
            client=client,
            model=model,
            max_turns=10,
            system_prompt=system_prompt,
        ):
            if isinstance(item, AssistantMessage):
                text = _assistant_text(item)
                if text:
                    final_text = text
            elif isinstance(item, AgentStopEvent):
                stop_reason = item.stop_reason
        run.exit_code = 0
        run.status = "success" if stop_reason != "max_turns" else "failed"
        run.summary = final_text
        run.stdout_tail = final_text[-64_000:]
        if stop_reason == "max_turns":
            run.error = "scheduled agent reached max turn limit"
    except Exception as exc:
        logger.exception("定时 agent 任务异常: job={} run={} error={}", job.id, run.id, exc)
        run.status = "failed"
        run.error = str(exc)

    return run
