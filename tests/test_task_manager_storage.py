import json
from pathlib import Path

from ripple.tasks.manager import TaskManager


def test_task_manager_writes_versioned_state(tmp_path: Path):
    storage_path = tmp_path / "tasks.json"
    manager = TaskManager(storage_path)

    task_id = manager.create_task("Plan", "Write the plan")

    data = json.loads(storage_path.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["tasks"][task_id]["subject"] == "Plan"


def test_task_manager_loads_legacy_plain_task_mapping(tmp_path: Path):
    storage_path = tmp_path / "tasks.json"
    storage_path.write_text(
        json.dumps(
            {
                "1": {
                    "id": "1",
                    "subject": "Legacy",
                    "description": "Old format",
                    "status": "pending",
                    "owner": None,
                    "blocks": [],
                    "blocked_by": [],
                    "active_form": None,
                    "metadata": {},
                    "created_at": "2026-05-19T00:00:00",
                    "updated_at": "2026-05-19T00:00:00",
                }
            }
        ),
        encoding="utf-8",
    )

    manager = TaskManager(storage_path)

    assert manager.get_task("1").subject == "Legacy"
