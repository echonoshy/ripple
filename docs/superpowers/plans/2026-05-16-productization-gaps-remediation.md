# Productization Gaps Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the backend gaps that block a user-facing Ripple Web product model: durable runs, run event streaming, lightweight document metadata, internal user quota records, and Codex-only documentation cleanup.

**Architecture:** Keep Ripple as the control plane and Codex as the execution plane. Add durable indexes around existing files instead of replacing the current runtime: agent runs remain backed by `events.jsonl` and `output.txt`, documents remain backed by workspace files, and users remain addressed by `X-Ripple-User-Id` while Ripple records internal profile/quota metadata.

**Tech Stack:** FastAPI, Pydantic, pathlib, JSON/JSONL runtime metadata under `.ripple/sandboxes/<user_id>/`, pytest, Vite/React follow-up consumers.

---

## Scope

This plan covers backend and documentation foundations. It does not introduce public signup, billing, payment plans, external identity providers, or a full document database.

In scope:

- `/v1/runs` event streaming and replay.
- Durable per-user run index that survives server restarts.
- Minimal document/project metadata index over workspace files.
- Internal user profile and quota records.
- Quota enforcement at stable control-plane boundaries.
- README/config cleanup for the Codex-only runtime.

Out of scope:

- Billing, invoices, subscriptions, seats, or payment-provider integration.
- Full auth/session system for internet-facing public users.
- Full-text search engine, semantic search, or document version snapshots.
- Migrating old Ripple tool compatibility modules.

## Implementation Order

1. Run event streaming and durable run index.
2. User profile/quota records and enforcement.
3. Document metadata index.
4. Web API consumption follow-up.
5. README/config cleanup.

This order lets Web move from "chat-only session UI" to "tasks/files/account status" without waiting for a complete product data model.

## File Map

- Modify `src/ripple/agent_runners/manager.py`
  - Add durable job metadata writes and recovery helpers.
  - Keep in-memory `asyncio.Task` only for live jobs.
- Create `src/ripple/agent_runners/job_store.py`
  - Own run `meta.json` read/write, per-user listing, and event tail helpers.
- Modify `src/interfaces/server/routes.py`
  - Add `GET /v1/runs`, `GET /v1/runs/{job_id}/events`.
  - Use durable lookup for completed runs after restart.
  - Add quota and document endpoints.
- Modify `src/interfaces/server/schemas.py`
  - Add response/request models for run events, user profile/quota, and documents.
- Create `src/interfaces/server/run_events.py`
  - Convert run `events.jsonl` into SSE frames with replay and heartbeat.
- Create `src/ripple/users/store.py`
  - Store internal user profile/quota metadata under each user sandbox.
- Create `src/ripple/users/quota.py`
  - Centralize quota defaults, usage calculation, and enforcement checks.
- Create `src/ripple/documents/store.py`
  - Maintain lightweight document metadata linked to workspace paths.
- Modify `src/interfaces/server/workspace_browser.py`
  - Optionally expose document-friendly metadata, without changing core file APIs.
- Modify `src/interfaces/web/src/lib/api.ts`
  - Follow-up after backend: add typed clients for runs, run SSE, documents, and quota status.
- Modify `README.md`
  - Remove stale tool/scheduler framing and describe current Codex-only runtime.
- Modify `config/settings.yaml.sample`
  - Replace stale `tools` emphasis with active control-plane/runtime quota settings.
- Add or modify tests:
  - `tests/test_agent_run_routes.py`
  - `tests/test_agent_run_job_store.py`
  - `tests/test_user_quota_routes.py`
  - `tests/test_document_routes.py`
  - `tests/test_workspace_routes.py`

---

## Task 1: Durable Agent Run Metadata

**Files:**

- Create: `src/ripple/agent_runners/job_store.py`
- Modify: `src/ripple/agent_runners/manager.py`
- Modify: `src/interfaces/server/schemas.py`
- Test: `tests/test_agent_run_job_store.py`

- [ ] Define the durable run directory layout.

  Use the existing runtime root:

  ```text
  .ripple/sandboxes/<user_id>/agent-runs/external-agents/<job_id>/
    meta.json
    events.jsonl
    output.txt
  ```

  `meta.json` should include:

  ```json
  {
    "job_id": "agent-abc123",
    "provider": "codex",
    "user_id": "alice",
    "session_id": null,
    "prompt_preview": "First 240 chars of prompt",
    "cwd": "/absolute/host/workspace",
    "sandbox_cwd": "/workspace",
    "status": "running",
    "created_at": "2026-05-16T00:00:00+00:00",
    "updated_at": "2026-05-16T00:00:01+00:00",
    "events_file": "/absolute/path/events.jsonl",
    "output_file": "/absolute/path/output.txt",
    "exit_code": null,
    "error": null
  }
  ```

- [ ] Add `AgentRunRecord` helpers in `job_store.py`.

  Required functions:

  - `record_from_job(job: ExternalAgentJob) -> dict`
  - `write_job_meta(job: ExternalAgentJob) -> None`
  - `read_job_meta(job_dir: Path) -> dict | None`
  - `list_user_job_records(agent_runs_dir: Path) -> list[dict]`
  - `find_user_job_record(agent_runs_dir: Path, job_id: str) -> dict | None`

- [ ] Write failing tests for metadata write/read.

  Test cases:

  - writing a running job creates `meta.json`;
  - applying a completed result updates `status`, `updated_at`, `events_file`, `output_file`;
  - listing ignores corrupt JSON and directories without `meta.json`;
  - returned records are sorted by `updated_at` descending.

  Run:

  ```bash
  uv run pytest tests/test_agent_run_job_store.py -q
  ```

  Expected before implementation: failures for missing module/functions.

- [ ] Update `ExternalAgentManager.start()` to create job dir and write initial `meta.json`.

  Keep `self.jobs[job_id]` as the live registry. Durable metadata is additive.

- [ ] Update `ExternalAgentJob.apply_result()` and failure/cancel branches in `_run_job()` to persist final metadata.

  Persist after:

  - normal completion;
  - provider exception;
  - cancellation.

- [ ] Run targeted tests.

  ```bash
  uv run pytest tests/test_agent_run_job_store.py tests/test_agent_run_service.py -q
  ```

  Expected: all pass.

---

## Task 2: Run List And Restart-Safe Status API

**Files:**

- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/schemas.py`
- Test: `tests/test_agent_run_routes.py`

- [ ] Add schemas.

  Add:

  - `AgentRunListResponse`
  - `AgentRunRecordInfo`

  Fields should mirror existing `AgentRunInfo` where possible:

  - `job_id`
  - `provider`
  - `status`
  - `created_at`
  - `updated_at`
  - `events_file`
  - `output_file`
  - `exit_code`
  - `error`
  - `prompt_preview`
  - `sandbox_cwd`

- [ ] Add `GET /v1/runs`.

  Behavior:

  - Reads only current `X-Ripple-User-Id`.
  - Returns durable records from the user's `agent-runs/external-agents`.
  - Overlays live in-memory job state when the job is still present in `ExternalAgentManager.jobs`.
  - Does not expose other users' paths or runs.

- [ ] Make `GET /v1/runs/{job_id}` durable-aware.

  Lookup order:

  1. live manager job with matching `user_id`;
  2. durable `meta.json` under the current user's run directory.

  If found only on disk, return status and file pointers, but no live task controls.

- [ ] Keep `steer` and `cancel` live-only.

  Behavior:

  - If durable record exists but no live job exists, return `409 Conflict`.
  - Message: `Agent run is not active`.
  - Do not pretend cancellation succeeded for a restarted/completed job.

- [ ] Write route tests.

  Test cases:

  - list returns current user's runs only;
  - get returns a run after clearing `ExternalAgentManager.jobs`;
  - cancel after registry loss returns `409`;
  - steer after registry loss returns `409`.

- [ ] Run targeted tests.

  ```bash
  uv run pytest tests/test_agent_run_routes.py -q
  ```

---

## Task 3: Run Events SSE

**Files:**

- Create: `src/interfaces/server/run_events.py`
- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/schemas.py`
- Test: `tests/test_agent_run_routes.py`

- [ ] Define `GET /v1/runs/{job_id}/events`.

  Query parameters:

  - `from_start: bool = true`
  - `follow: bool = true`
  - `heartbeat_seconds: int = 8`

  Response:

  - `text/event-stream`
  - each JSONL event becomes one SSE `data: <json>\n\n`
  - emits `data: [DONE]\n\n` when `follow=false` or the live job reaches terminal status.

- [ ] Implement replay.

  If `from_start=true`, stream all existing lines from `events.jsonl`.

  If `from_start=false`, seek to EOF first and only stream new events.

- [ ] Implement follow mode.

  While live job status is running:

  - poll appended JSONL lines;
  - emit heartbeat when no events arrive for `heartbeat_seconds`;
  - stop when job becomes `completed`, `failed`, or `cancelled`.

  If job is disk-only, replay existing events and finish.

- [ ] Preserve authorization boundary.

  Reuse current user lookup. A job id from another user must return `404`.

- [ ] Write tests.

  Test cases:

  - replay existing events returns expected JSON event payload;
  - disk-only run streams historical events and `[DONE]`;
  - other user cannot stream events;
  - invalid/corrupt JSONL line is skipped, not fatal.

- [ ] Run targeted tests.

  ```bash
  uv run pytest tests/test_agent_run_routes.py -q
  ```

---

## Task 4: Internal User Profile And Quota Store

**Files:**

- Create: `src/ripple/users/store.py`
- Create: `src/ripple/users/quota.py`
- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/schemas.py`
- Modify: `config/settings.yaml.sample`
- Test: `tests/test_user_quota_routes.py`

- [ ] Add config defaults.

  Suggested sample config:

  ```yaml
  users:
    quota_defaults:
      max_workspace_mb: 2048
      max_sessions: 200
      max_runs_per_day: 200
      max_run_runtime_seconds: 3600
  ```

  This is internal quota only. Do not add billing fields.

- [ ] Define per-user metadata location.

  Store:

  ```text
  .ripple/sandboxes/<user_id>/user.json
  ```

  Shape:

  ```json
  {
    "user_id": "alice",
    "display_name": "alice",
    "created_at": "2026-05-16T00:00:00+00:00",
    "updated_at": "2026-05-16T00:00:00+00:00",
    "quota": {
      "max_workspace_mb": 2048,
      "max_sessions": 200,
      "max_runs_per_day": 200,
      "max_run_runtime_seconds": 3600
    }
  }
  ```

- [ ] Add user/quota endpoints.

  Internal API:

  - `GET /v1/users/me`
  - `GET /v1/users/me/quota`
  - `PUT /v1/users/{user_id}/quota`

  For now, protect all three with the existing API key mechanism. `PUT` should only operate on a valid user id and can be considered operator/internal.

- [ ] Add quota usage calculation.

  Usage fields:

  - `workspace_size_bytes`
  - `session_count`
  - `runs_today`
  - `active_runs`

  Use existing sandbox/session/run files. Do not add a database.

- [ ] Enforce quota at stable boundaries.

  Enforce:

  - `/v1/runs`: reject when `runs_today >= max_runs_per_day`;
  - `/v1/runs`: cap request `max_runtime_seconds` to user quota or reject with `403`;
  - `/v1/sessions`: reject new session when `session_count >= max_sessions`;
  - `/v1/workspace/file` save: reject when resulting workspace size would exceed `max_workspace_mb`.

  Error shape should be consistent:

  ```json
  {
    "detail": {
      "code": "quota_exceeded",
      "resource": "runs_per_day",
      "limit": 200,
      "used": 200
    }
  }
  ```

- [ ] Write tests.

  Test cases:

  - `GET /v1/users/me/quota` creates defaults on first access;
  - run creation rejects over daily limit;
  - run creation rejects over runtime limit;
  - session creation rejects over max sessions;
  - workspace save rejects over max workspace size.

- [ ] Run targeted tests.

  ```bash
  uv run pytest tests/test_user_quota_routes.py tests/test_agent_run_routes.py tests/test_workspace_routes.py -q
  ```

---

## Task 5: Lightweight Document Metadata Index

**Files:**

- Create: `src/ripple/documents/store.py`
- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/schemas.py`
- Test: `tests/test_document_routes.py`

- [ ] Define document metadata location.

  Store:

  ```text
  .ripple/sandboxes/<user_id>/documents/index.json
  ```

  Shape:

  ```json
  {
    "documents": [
      {
        "document_id": "doc-abc123",
        "title": "Project brief",
        "path": "/workspace/docs/brief.md",
        "kind": "markdown",
        "source": "workspace",
        "linked_session_id": "session-123",
        "summary": "",
        "created_at": "2026-05-16T00:00:00+00:00",
        "updated_at": "2026-05-16T00:00:00+00:00",
        "last_modified_at": "2026-05-16T00:00:00+00:00"
      }
    ]
  }
  ```

- [ ] Add document endpoints.

  - `GET /v1/documents`
  - `POST /v1/documents`
  - `GET /v1/documents/{document_id}`
  - `PATCH /v1/documents/{document_id}`
  - `DELETE /v1/documents/{document_id}`

  Keep content reads/writes in `/v1/workspace/file`; documents are metadata pointers.

- [ ] Add optional path discovery.

  `POST /v1/documents` should validate that `path` exists under workspace and is a file.

  It should infer `kind` from extension:

  - `.md`, `.markdown` -> `markdown`
  - `.txt` -> `text`
  - `.json`, `.yaml`, `.yml` -> `data`
  - otherwise `file`

- [ ] Add basic search by metadata only.

  `GET /v1/documents?q=brief` should match title, path, summary. No full-text file scan in this phase.

- [ ] Write tests.

  Test cases:

  - create document metadata for an existing workspace file;
  - reject path outside workspace;
  - list filters by query;
  - patch title/summary/linked session;
  - delete removes metadata but does not delete the underlying file.

- [ ] Run targeted tests.

  ```bash
  uv run pytest tests/test_document_routes.py tests/test_workspace_routes.py -q
  ```

---

## Task 6: Web API Follow-Up

**Files:**

- Modify: `src/interfaces/web/src/lib/api.ts`
- Modify: `src/interfaces/web/src/types/index.ts`
- Later UI files depend on the chosen redesign.

- [ ] Add typed API clients only after backend tests pass.

  Add functions:

  - `fetchRuns()`
  - `fetchRun(jobId)`
  - `streamRunEvents(jobId, callbacks)`
  - `fetchUserQuota()`
  - `fetchDocuments(query?)`
  - `createDocument(payload)`
  - `updateDocument(documentId, payload)`
  - `deleteDocument(documentId)`

- [ ] Keep UI changes separate.

  Do not mix product layout redesign with backend client additions. First expose the API cleanly, then refactor UI language from sessions/workspace to tasks/files/account.

- [ ] Run frontend verification.

  ```bash
  cd src/interfaces/web
  bun run lint
  bun run build
  ```

---

## Task 7: Documentation And Config Cleanup

**Files:**

- Modify: `README.md`
- Modify: `config/settings.yaml.sample`
- Optional: update docs generated from README if the project requires it.
- Test: `tests/test_legacy_loop_removed.py`

- [ ] Update README product/runtime framing.

  Replace stale claims:

  - remove "内置工具系统：包含 Bash、Read、Write、Skill、AgentRunner 等工具" from feature overview;
  - remove `scheduler/` from active project structure;
  - describe `/v1/runs` as the external scheduler integration point;
  - describe workspace file API as current file/document substrate;
  - describe internal user quota records and explicitly state billing is out of scope.

- [ ] Update config sample.

  Keep legacy compatibility comments only when they are still needed by code. Add `users.quota_defaults`.

- [ ] Add a regression assertion for stale docs if useful.

  Extend `tests/test_legacy_loop_removed.py` to catch README references to active embedded scheduler claims.

- [ ] Run docs/runtime checks.

  ```bash
  uv run pytest tests/test_legacy_loop_removed.py -q
  uv run ruff format .
  uv run ruff check .
  ```

---

## Verification Matrix

Run after backend tasks:

```bash
uv run pytest tests/test_agent_run_job_store.py tests/test_agent_run_routes.py tests/test_user_quota_routes.py tests/test_document_routes.py tests/test_workspace_routes.py -q
uv run ruff format .
uv run ruff check .
```

Run after frontend client task:

```bash
cd src/interfaces/web
bun run lint
bun run build
```

Manual checks:

- Start backend with `uv run ripple --reload`.
- Create a run with `POST /v1/runs`.
- Open `GET /v1/runs/{job_id}/events` and confirm replay.
- Restart backend.
- Confirm `GET /v1/runs` and `GET /v1/runs/{job_id}` still return completed run records.
- Confirm `POST /v1/runs/{job_id}/cancel` returns `409` for disk-only records.
- Confirm `GET /v1/users/me/quota` reports workspace/session/run usage.
- Confirm document metadata can be created for an existing workspace file without copying file content.

## Risk Notes

- Durable run recovery must not resurrect live tasks. A restarted server can show historical status and events, but cannot steer or cancel a process that no longer exists.
- Quota checks should fail closed at write/start boundaries, but should not block read-only APIs.
- Document metadata should never become the source of truth for file content. Workspace files remain canonical.
- Do not expose absolute host paths to Web users if the UI does not need them; keep public paths in `/workspace/...` form where possible.

