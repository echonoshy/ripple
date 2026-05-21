"""Codex plan event normalization helpers."""

from typing import Any


def _normalize_plan_step_status(status: Any) -> str:
    if status == "completed":
        return "completed"
    if status in {"inProgress", "in_progress"}:
        return "in_progress"
    return "pending"


def extract_plan_update_event(event: dict[str, Any]) -> dict[str, Any] | None:
    if event.get("type") != "codex.notification":
        return None
    message = (event.get("data") or {}).get("message")
    if not isinstance(message, dict) or message.get("method") != "turn/plan/updated":
        return None
    params = message.get("params", {})
    if not isinstance(params, dict):
        return None
    raw_plan = params.get("plan")
    if not isinstance(raw_plan, list):
        return None

    turn_id = params.get("turnId")
    turn_id = turn_id if isinstance(turn_id, str) and turn_id else "unknown-turn"
    steps: list[dict[str, str]] = []
    for index, item in enumerate(raw_plan):
        if not isinstance(item, dict):
            continue
        step = item.get("step")
        if not isinstance(step, str) or not step.strip():
            continue
        steps.append(
            {
                "id": f"codex-plan:{turn_id}:{index}",
                "subject": step,
                "status": _normalize_plan_step_status(item.get("status")),
            }
        )

    completed = sum(1 for step in steps if step["status"] == "completed")
    current_task = next((step["subject"] for step in steps if step["status"] == "in_progress"), None)
    if current_task is None:
        current_task = next((step["subject"] for step in steps if step["status"] == "pending"), None)
    total = len(steps)
    thread_id = params.get("threadId")
    explanation = params.get("explanation")
    return {
        "type": "task_plan_updated",
        "thread_id": thread_id if isinstance(thread_id, str) else None,
        "turn_id": turn_id,
        "explanation": explanation if isinstance(explanation, str) else None,
        "steps": steps,
        "progress": {
            "completed": completed,
            "total": total,
            "currentTask": current_task,
        },
        "allCompleted": completed == total,
    }
