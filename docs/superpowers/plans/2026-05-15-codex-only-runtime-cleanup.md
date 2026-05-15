# Codex-Only Runtime Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the server-side Codex-only runtime boundary after embedded scheduler removal.

**Architecture:** Ripple keeps sessions, sandboxes, connectors, workspace APIs, `/v1/runs`, and Codex app-server process management. Runtime model tools become empty, direct `/v1/tools/invoke` stops executing, Codex prompts include connector status and a compact skill manifest, shared skills are mounted at stable sandbox paths, and Codex app-server approval requests are recorded and resolvable through Ripple.

**Tech Stack:** Python 3.13, FastAPI, pytest, ruff.

---

## File Structure

- Create `src/ripple/skills/manifest.py` for skill manifest entries and shared skill sandbox path mapping.
- Create `src/ripple/agent_runners/approvals.py` for Codex approval request parsing and response mapping.
- Modify `src/interfaces/server/sessions.py` to return no model-facing tools and use a Codex control-plane prompt.
- Modify `src/interfaces/server/codex_chat.py` to include skill manifest text and surface streamed approval requests to session state.
- Modify `src/interfaces/server/routes.py` to deprecate `/v1/tools/invoke`, stop legacy permission replay, and resolve Codex approvals.
- Modify `src/interfaces/server/schemas.py` to include pending approval data on `/v1/runs`.
- Modify `src/ripple/agent_runners/codex_app_server.py` to detect server approval requests and send decisions back to app-server.
- Modify `src/ripple/agent_runners/manager.py` to expose pending and resolved approval operations.
- Modify `src/ripple/sandbox/nsjail_config.py` to mount shared skills at `/opt/ripple/skills/shared/...`.
- Add or update tests:
  - `tests/test_codex_only_runtime.py`
  - `tests/test_codex_chat_routes.py`
  - `tests/test_codex_app_server_runner.py`

---

### Task 1: Remove Model-Facing Ripple Tools

- [x] Add tests that `get_server_tool_names()` and `/v1/info` report no tools, and `/v1/tools/invoke` returns `410`.
- [x] Replace `_get_server_tools()` with an empty list and remove old built-in tool imports from `sessions.py`.
- [x] Replace the default server prompt with Codex-only control-plane guidance.
- [x] Replace `/v1/tools/invoke` with a `410 Gone` response.
- [x] Run `uv run pytest tests/test_codex_only_runtime.py -q`.

### Task 2: Add Skill Manifest and Stable Shared Skill Mounts

- [x] Add tests for shared and workspace skill manifest entries.
- [x] Add a test that nsjail mounts shared skill directories under `/opt/ripple/skills/shared/...`.
- [x] Implement `ripple.skills.manifest`.
- [x] Include the skill manifest in `build_codex_chat_prompt()`.
- [x] Update `nsjail_config.py` to use the manifest shared mount mapping.
- [x] Run skill and chat prompt tests.

### Task 3: Add Codex Approval Bridge Core

- [x] Add tests for parsing Codex server approval requests and mapping allow/always/deny responses.
- [x] Add tests where a fake app-server emits `item/commandExecution/requestApproval`, receives a JSON-RPC response, and then completes.
- [x] Implement approval parsing/response helpers.
- [x] Add `CodexAppServerSession.respond()` and provider pending approval storage.
- [x] Add `ExternalAgentManager.get_pending_approval()` and `resolve_approval()`.
- [x] Add `pending_approval` to `/v1/runs/{job_id}` responses.
- [x] Update session permission resolve to forward Codex approval decisions instead of replaying Ripple tools.
- [x] Run approval-focused tests.

### Task 4: Verification

- [x] Run `uv run ruff format .`.
- [x] Run `uv run ruff check .`.
- [x] Run `uv run pytest -q`.
