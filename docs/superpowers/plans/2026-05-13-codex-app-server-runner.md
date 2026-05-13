# Codex App Server Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Codex SDK bridge with a per-user Codex app-server runner that treats Codex as a trusted executor inside the current user's sandbox.

**Architecture:** Ripple owns routing, job state, event logs, cancellation, and per-user app-server process lifecycle. Codex app-server is installed once on the host but started lazily per `user_id`; each job starts an independent thread/turn in that user's sandbox workspace.

**Tech Stack:** Python 3.13, asyncio subprocesses, JSON-RPC over stdio, Pydantic, pytest, existing Ripple tool/session APIs.

---

### Task 1: App Server Process Client

**Files:**
- Create: `src/ripple/agent_runners/codex_app_server.py`
- Modify: `src/ripple/agent_runners/models.py`
- Test: `tests/test_codex_app_server_runner.py`

- [ ] Write a failing test with a fake app-server script that verifies `initialize`, `thread/start`, and `turn/start` JSON-RPC requests are sent.
- [ ] Implement a focused async JSON-RPC stdio client that records notifications as `AgentRunnerEvent` entries.
- [ ] Run `uv run pytest tests/test_codex_app_server_runner.py`.

### Task 2: Per-User Lifecycle And Cancellation

**Files:**
- Modify: `src/ripple/agent_runners/codex_app_server.py`
- Modify: `src/ripple/agent_runners/manager.py`
- Test: `tests/test_codex_app_server_runner.py`

- [ ] Write failing tests that two jobs for one `user_id` reuse one app-server process, two users get separate processes, and cancellation sends `turn/interrupt`.
- [ ] Add a `CodexAppServerPool` keyed by `user_id`, with lazy start, idle shutdown support, and provider-level `cancel(job_id)`.
- [ ] Run `uv run pytest tests/test_codex_app_server_runner.py`.

### Task 3: AgentRunner Tool Surface

**Files:**
- Create: `src/ripple/tools/builtin/agent_runner.py`
- Modify: `src/interfaces/server/sessions.py`
- Modify: `src/ripple/agent_runners/router.py`
- Test: `tests/test_agent_runner_tool.py`

- [ ] Write failing tests for `AgentRunner` start/status/cancel and non-privileged complex routing.
- [ ] Rename the tool to `AgentRunner`, keep Codex as the only configured provider, and describe it as the complex trusted sandbox executor.
- [ ] Run `uv run pytest tests/test_agent_runner_tool.py tests/test_agent_router.py`.

### Task 4: Config And Verification

**Files:**
- Modify: `config/settings.yaml.sample`
- Modify: app-server related tests after formatter output.

- [ ] Replace SDK config with app-server config: `codex_executable`, `approval_policy`, `sandbox`, `network_access`, and `idle_timeout_seconds`.
- [ ] Run `uv run ruff format .`.
- [ ] Run `uv run ruff check .`.
- [ ] Run the targeted pytest suite for agent runners and tools.
