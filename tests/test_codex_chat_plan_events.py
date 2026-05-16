from interfaces.server import codex_chat


def test_extract_plan_update_event_maps_codex_snapshot_to_task_plan_event() -> None:
    event = {
        "type": "codex.notification",
        "data": {
            "message": {
                "method": "turn/plan/updated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "explanation": "checking the bridge",
                    "plan": [
                        {"step": "Inspect current bridge", "status": "completed"},
                        {"step": "Map event to UI", "status": "inProgress"},
                        {"step": "Verify behavior", "status": "pending"},
                    ],
                },
            }
        },
    }

    extract = getattr(codex_chat, "_extract_plan_update_event", lambda _event: None)

    assert extract(event) == {
        "type": "task_plan_updated",
        "thread_id": "thread-1",
        "turn_id": "turn-1",
        "explanation": "checking the bridge",
        "steps": [
            {
                "id": "codex-plan:turn-1:0",
                "subject": "Inspect current bridge",
                "status": "completed",
            },
            {
                "id": "codex-plan:turn-1:1",
                "subject": "Map event to UI",
                "status": "in_progress",
            },
            {
                "id": "codex-plan:turn-1:2",
                "subject": "Verify behavior",
                "status": "pending",
            },
        ],
        "progress": {
            "completed": 1,
            "total": 3,
            "currentTask": "Map event to UI",
        },
        "allCompleted": False,
    }


def test_extract_plan_update_event_marks_empty_or_all_completed_plan_done() -> None:
    event = {
        "type": "codex.notification",
        "data": {
            "message": {
                "method": "turn/plan/updated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-2",
                    "plan": [
                        {"step": "Inspect current bridge", "status": "completed"},
                        {"step": "Map event to UI", "status": "completed"},
                    ],
                },
            }
        },
    }

    extract = getattr(codex_chat, "_extract_plan_update_event", lambda _event: None)

    assert extract(event)["allCompleted"] is True
