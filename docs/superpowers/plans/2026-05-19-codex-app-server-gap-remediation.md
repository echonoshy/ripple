# Codex App Server Gap Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the current Codex app-server integration gaps without changing Ripple's Codex-only control-plane boundary.

**Architecture:** Keep Ripple sessions as the user-facing lifecycle owner and keep Codex app-server runs isolated by `user_id`. Add explicit unsupported responses for non-approval server-initiated JSON-RPC requests, pass turn configuration through `AgentRunnerRequest`, normalize more Codex events for clients, and allow `/v1/runs` callers to submit native Codex input items.

**Tech Stack:** FastAPI, Pydantic v2, pytest, Codex app-server JSON-RPC over stdio.

---

### Task 1: Runner Request Handling And Turn Params

**Files:**
- Modify: `src/ripple/agent_runners/models.py`
- Modify: `src/ripple/agent_runners/service.py`
- Modify: `src/ripple/agent_runners/codex_app_server.py`
- Test: `tests/test_codex_app_server_runner.py`
- Test: `tests/test_agent_run_service.py`

- [x] **Step 1: Write failing tests**

Cover:
- unknown server-initiated JSON-RPC request receives a JSON-RPC error response and the run completes;
- `model`, `effort`, `summary`, and `outputSchema` reach `turn/start`;
- `start_agent_run` preserves these fields in `AgentRunnerRequest`.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_codex_app_server_runner.py::test_app_server_provider_declines_unsupported_server_request tests/test_codex_app_server_runner.py::test_app_server_provider_forwards_turn_configuration tests/test_agent_run_service.py::test_start_agent_run_forwards_turn_configuration -q
```

- [x] **Step 3: Implement minimal runner changes**

Add optional turn config fields to `AgentRunnerRequest`, pass them through `start_agent_run`, build optional `turn/start` params, and add `CodexAppServerSession.respond_error`.

- [x] **Step 4: Run focused tests**

Run the command from Step 2 again.

### Task 2: API Schema And Native Runs Input

**Files:**
- Modify: `src/interfaces/server/schemas.py`
- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/codex_chat.py`
- Test: `tests/test_agent_run_routes.py`
- Test: `tests/test_codex_chat_routes.py`

- [x] **Step 1: Write failing tests**

Cover:
- `/v1/runs` accepts `input_items` and forwards them to Codex;
- `/v1/runs` accepts `outputSchema` alias and forwards as `output_schema`;
- `/v1/chat/completions` forwards resolved model, preset effort, and explicit `summary`/`outputSchema`.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_agent_run_routes.py::test_agent_run_accepts_native_input_items_and_turn_configuration tests/test_codex_chat_routes.py::test_chat_completions_forwards_codex_turn_configuration -q
```

- [x] **Step 3: Implement API changes**

Add schema fields and thread them into `start_agent_run` from chat and runs routes.

- [x] **Step 4: Run focused tests**

Run the command from Step 2 again.

### Task 3: Normalized Runtime Events

**Files:**
- Create: `src/interfaces/server/codex_runtime_events.py`
- Modify: `src/interfaces/server/codex_chat.py`
- Modify: `src/interfaces/server/run_events.py`
- Test: `tests/test_agent_run_routes.py`
- Test: `tests/test_codex_chat_routes.py`

- [x] **Step 1: Write failing tests**

Cover normalized SSE events for turn diff updates, command/file deltas, warnings/errors, and context compaction.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_agent_run_routes.py::test_agent_run_events_emit_normalized_codex_runtime_events tests/test_codex_chat_routes.py::test_chat_completions_stream_bridges_runtime_events_to_sse -q
```

- [x] **Step 3: Implement event mapper**

Centralize normalization in `codex_runtime_events.py` and use it from chat and runs streaming.

- [x] **Step 4: Run focused tests**

Run the command from Step 2 again.

### Task 4: Persistent Thread Decision Record

**Files:**
- Create: `docs/CODEX_APP_SERVER_INTEGRATION.md`

- [x] **Step 1: Record the decision**

Document that persistent Codex threads stay disabled for now, and define the future mapping:
`(user_id, ripple_session_id) -> codex_thread_id`, stored in session metadata only after per-user Codex state isolation is ready.

- [x] **Step 2: State isolation constraints**

Document that thread reuse must be scoped by `user_id`, must not share server Codex credentials, and must validate that a restored thread belongs to the same Ripple session and workspace.

### Task 5: Final Verification

- [x] **Step 1: Format**

```bash
uv run ruff format .
```

- [x] **Step 2: Lint**

```bash
uv run ruff check .
```

- [x] **Step 3: Test**

```bash
uv run pytest -q
```
