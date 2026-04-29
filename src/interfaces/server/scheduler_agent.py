"""Agent runner used by scheduled jobs."""

from datetime import datetime, timezone
from uuid import uuid4

from interfaces.server.sessions import _create_session_context, _merge_system_prompt
from ripple.core.agent_loop import query
from ripple.messages.types import AgentStopEvent, AssistantMessage, Message
from ripple.sandbox.manager import SandboxManager
from ripple.sandbox.storage import save_session_state
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
    """Run an agent prompt for a scheduled job and store a resumable transcript."""

    prompt = (job.prompt or "").strip()
    if not prompt:
        run.status = "failed"
        run.error = "agent schedule prompt is empty"
        return run

    config = get_config()
    model = config.resolve_model(config.get("model.default", "sonnet"))
    display_session_id = f"sched-{job.id}-{run.id}"
    internal_session_id = f"sched-{uuid4().hex[:12]}"

    sandbox_manager.setup_session(job.user_id, display_session_id)
    workspace_root = sandbox_manager.config.workspace_dir(job.user_id)
    session_runtime_dir = sandbox_manager.config.session_dir(job.user_id, display_session_id)

    context, client = _create_session_context(
        model,
        internal_session_id,
        workspace_root=workspace_root,
        sandbox_session_id=display_session_id,
        session_runtime_dir=session_runtime_dir,
        user_id=job.user_id,
        sandbox_manager=sandbox_manager,
    )
    system_prompt = _merge_system_prompt(workspace_root, None)

    messages: list[Message] = []
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
                messages.append(item)
                text = _assistant_text(item)
                if text:
                    final_text = text
            elif isinstance(item, AgentStopEvent):
                stop_reason = item.stop_reason
        messages = list(context.current_messages or messages)
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
    finally:
        now = datetime.now(timezone.utc)
        save_session_state(
            sandbox_manager.config,
            job.user_id,
            display_session_id,
            messages=messages,
            model_messages=context.current_messages or messages,
            model=model,
            caller_system_prompt=None,
            max_turns=10,
            total_input_tokens=0,
            total_output_tokens=0,
            created_at=run.started_at,
            last_active=now,
            status="idle",
        )

    return run
