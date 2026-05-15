# Remove Embedded Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Ripple's embedded scheduler runtime and make `/v1/runs` the only server-side entry point external schedulers need to trigger Codex work.

**Architecture:** Keep the existing run/session/sandbox/connector control plane intact. Replace schedule API behavior with a clear `410 Gone` response, remove scheduler startup and model-facing `ScheduleTool`, and delete scheduler-only runtime code and tests.

**Tech Stack:** Python 3.13, FastAPI, pytest, ruff.

---

## File Structure

- Modify `docs/superpowers/specs/2026-05-15-codex-only-execution-plane-design.md` so scheduler is no longer retained.
- Create `tests/test_scheduler_removed.py` to lock the deprecated schedule API and tool list behavior.
- Modify `src/interfaces/server/routes.py` to remove scheduler manager state and return `410` for `/v1/sandbox/schedules*`.
- Modify `src/interfaces/server/app.py` to stop constructing or starting `SchedulerManager`.
- Modify `src/interfaces/server/sessions.py` to remove `ScheduleTool` and scheduled-work prompt instructions.
- Modify `src/ripple/agent_runners/router.py` so schedule/reminder wording no longer routes to removed Ripple tools.
- Modify `src/ripple/tools/builtin/bash.py` to stop instructing users to use the removed Schedule tool.
- Delete scheduler-only files after tests cover the new behavior:
  - `src/interfaces/server/scheduler_agent.py`
  - `src/ripple/tools/builtin/schedule.py`
  - `src/ripple/scheduler/models.py`
  - `src/ripple/scheduler/store.py`
  - `src/ripple/scheduler/manager.py`
  - `tests/test_scheduler_agent_codex.py`

---

### Task 1: Lock Deprecated Schedule API Behavior

**Files:**
- Create: `tests/test_scheduler_removed.py`

- [x] **Step 1: Write the failing route tests**

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.auth import verify_api_key
from interfaces.server.routes import router


def _client() -> TestClient:
    app = FastAPI()
    app.dependency_overrides[verify_api_key] = lambda: "test"
    app.include_router(router)
    return TestClient(app, headers={"X-Ripple-User-Id": "alice"})


def test_schedule_collection_endpoint_returns_gone():
    response = _client().get("/v1/sandbox/schedules")

    assert response.status_code == 410
    assert "/v1/runs" in response.json()["detail"]


def test_schedule_nested_endpoint_returns_gone():
    response = _client().post("/v1/sandbox/schedules/job-123/run")

    assert response.status_code == 410
    assert "/v1/runs" in response.json()["detail"]
```

- [x] **Step 2: Verify the route tests fail**

Run: `uv run pytest tests/test_scheduler_removed.py -q`

Expected: FAIL because current schedule routes still try to use `SchedulerManager`.

- [x] **Step 3: Add tool list regression test**

Append to `tests/test_scheduler_removed.py`:

```python
from interfaces.server.sessions import get_server_tool_names


def test_schedule_tool_is_not_model_facing():
    assert "Schedule" not in get_server_tool_names()
```

- [x] **Step 4: Verify the tool test fails**

Run: `uv run pytest tests/test_scheduler_removed.py::test_schedule_tool_is_not_model_facing -q`

Expected: FAIL because `ScheduleTool` is still included in server tools.

---

### Task 2: Remove Scheduler From Runtime Wiring

**Files:**
- Modify: `src/interfaces/server/app.py`
- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/sessions.py`
- Modify: `src/ripple/agent_runners/router.py`
- Modify: `src/ripple/tools/builtin/bash.py`

- [x] **Step 1: Remove scheduler startup from app**

In `src/interfaces/server/app.py`, remove imports for `set_scheduler_manager`, `run_scheduled_agent_job`, `SchedulerManager`, and `set_schedule_tool_manager`. Remove scheduler construction, `set_scheduler_manager`, `set_schedule_tool_manager`, `scheduler.start()`, and `await scheduler.stop()`.

- [x] **Step 2: Replace schedule routes with a deprecation handler**

In `src/interfaces/server/routes.py`, remove scheduler imports, global scheduler manager state, helper functions, and concrete CRUD/run route handlers. Add:

```python
SCHEDULES_REMOVED_DETAIL = "Ripple embedded scheduling has been removed. Use an external scheduler to call /v1/runs with the desired X-Ripple-User-Id."


@router.api_route("/v1/sandbox/schedules", methods=["GET", "POST", "PATCH", "DELETE"])
@router.api_route("/v1/sandbox/schedules/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
async def schedules_removed(
    _path: str | None = None,
    _api_key: str = Depends(verify_api_key),
):
    raise HTTPException(status_code=410, detail=SCHEDULES_REMOVED_DETAIL)
```

- [x] **Step 3: Remove Schedule tool from model-facing tools**

In `src/interfaces/server/sessions.py`, remove `ScheduleTool` import, remove `ScheduleTool()` from `_get_server_tools()`, and replace the scheduled-work prompt section with:

```text
## Scheduled Work
- Ripple does not provide an embedded scheduler in this server.
- If future or recurring execution is needed, the caller should use an external scheduler to call `/v1/runs` with the correct `X-Ripple-User-Id`.
- Do not use Bash with `sleep`, `at`, `cron`, timeout loops, or polling loops to emulate scheduled work inside a chat turn.
```

- [x] **Step 4: Remove stale Bash guidance**

In `src/ripple/tools/builtin/bash.py`, replace any guidance that says to use `Schedule` with guidance to use an external scheduler that calls `/v1/runs`.

- [x] **Step 5: Remove schedule/reminder routing to Ripple tools**

In `src/ripple/agent_runners/router.py`, remove the schedule/reminder basic-tool terms and the branch that returns `ExecutionRoute.RIPPLE_TOOLS` only because a prompt mentions scheduling.

- [x] **Step 6: Verify new behavior passes**

Run: `uv run pytest tests/test_scheduler_removed.py -q`

Expected: PASS.

---

### Task 3: Delete Scheduler-Only Code

**Files:**
- Delete: `src/interfaces/server/scheduler_agent.py`
- Delete: `src/ripple/tools/builtin/schedule.py`
- Delete: `src/ripple/scheduler/models.py`
- Delete: `src/ripple/scheduler/store.py`
- Delete: `src/ripple/scheduler/manager.py`
- Delete: `tests/test_scheduler_agent_codex.py`

- [x] **Step 1: Delete scheduler-only modules**

Use `apply_patch` delete hunks for each scheduler-only file listed above.

- [x] **Step 2: Search for stale imports**

Run: `rg -n "SchedulerManager|ScheduleTool|ScheduledJob|ScheduledRun|ripple.scheduler|scheduler_agent|set_schedule_tool_manager|set_scheduler_manager" src tests`

Expected: no matches.

- [x] **Step 3: Keep storage helpers only if still referenced**

Run: `rg -n "scheduled_tasks_dir|scheduled_jobs_file|scheduled_runs_dir" src tests`

Expected: only `src/ripple/sandbox/config.py` matches. If no runtime code uses those helpers, remove them from `SandboxConfig`.

---

### Task 4: Verification

**Files:**
- Modify only if verification exposes stale references.

- [x] **Step 1: Format**

Run: `uv run ruff format .`

Expected: command exits 0.

- [x] **Step 2: Lint**

Run: `uv run ruff check .`

Expected: command exits 0.

- [x] **Step 3: Targeted tests**

Run: `uv run pytest tests/test_scheduler_removed.py tests/test_agent_run_routes.py tests/test_codex_chat_routes.py tests/test_workspace_routes.py tests/test_connector_routes.py -q`

Expected: all selected tests pass.

- [x] **Step 4: Full backend test suite if targeted tests pass**

Run: `uv run pytest -q`

Expected: all tests pass, or any failure is unrelated and documented with exact failing test names.
