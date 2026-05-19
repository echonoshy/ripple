import json
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.reconcile import reconcile_stale_runtime_state


def test_reconcile_marks_stale_session_and_agent_run_as_failed(tmp_path: Path):
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    session_dir = config.session_dir("alice", "session-1")
    session_dir.mkdir(parents=True)
    meta_file = session_dir / "meta.json"
    meta_file.write_text(
        json.dumps(
            {
                "version": 2,
                "session_id": "session-1",
                "user_id": "alice",
                "status": "running",
                "pending_permission_request": {"job_id": "agent-1"},
            }
        ),
        encoding="utf-8",
    )

    run_dir = config.sandbox_dir("alice") / "agent-runs" / "external-agents" / "agent-1"
    run_dir.mkdir(parents=True)
    run_meta_file = run_dir / "meta.json"
    run_meta_file.write_text(
        json.dumps(
            {
                "job_id": "agent-1",
                "user_id": "alice",
                "status": "running",
                "updated_at": "2026-05-19T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )

    summary = reconcile_stale_runtime_state(config)

    session_meta = json.loads(meta_file.read_text(encoding="utf-8"))
    run_meta = json.loads(run_meta_file.read_text(encoding="utf-8"))
    assert summary == {"sessions": 1, "runs": 1}
    assert session_meta["status"] == "failed"
    assert session_meta["pending_permission_request"] is None
    assert "server restarted" in session_meta["error"]
    assert run_meta["status"] == "failed"
    assert "server restarted" in run_meta["error"]
