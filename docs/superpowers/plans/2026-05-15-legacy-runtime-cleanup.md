# Legacy Runtime Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete Ripple-owned execution runtime left behind after moving execution to Codex app-server.

**Architecture:** Ripple should keep the control plane: user sandboxes, sessions, connector auth, workspace browsing, skill discovery, and Codex app-server run management. Ripple should not keep a model-facing tool runtime, its own task/todo tools, or old tool permission replay code. Codex app-server remains the only execution plane.

**Tech Stack:** Python 3.13, FastAPI, pytest, ruff, TypeScript/Next.js cleanup deferred unless explicitly selected.

---

## Current State

The Codex-only server runtime is already active:

- `interfaces.server.sessions.get_server_tool_names()` returns `[]`.
- `/v1/tools/invoke` returns `410 Gone`.
- `/v1/sandbox/schedules*` returns `410 Gone`.
- Codex approval requests are surfaced through `session.pending_permission_request` with `source="codex"` and resolved by forwarding the decision to Codex app-server.
- Shared/workspace skills are exposed through `ripple.skills.manifest`, not through `SkillTool`.

The remaining obsolete code is mostly dormant source, old tests, old docs, and frontend assumptions.

## Keep

Do not delete these in this cleanup:

- `src/ripple/agent_runners/` except any stale references discovered by tests.
- `src/ripple/connectors/`.
- `src/ripple/sandbox/config.py`, `executor.py`, `manager.py`, `nsjail_config.py`, `workspace.py`, `storage.py`, and connector helpers such as `gogcli.py`, `gogcli_oauth.py`, `gogcli_registration.py`, `feishu.py`, `notion.py`, `bilibili.py`, `bilibili_gate.py`.
- `src/ripple/skills/loader.py`, `src/ripple/skills/types.py`, `src/ripple/skills/manifest.py`.
- `session.pending_permission_request` and `/v1/sessions/{session_id}/permissions/resolve` for now. The field name is still useful for UI compatibility, but it should only represent Codex approvals.
- `src/ripple/messages/types.py` and `src/ripple/messages/utils.py` until session message persistence is simplified. They still carry current session transcripts.

## Obsolete Inventory

### High Confidence Delete

These are no longer runtime entry points after Codex-only execution:

- `src/ripple/tools/base.py`
- `src/ripple/tools/orchestration.py`
- `src/ripple/tools/streaming_executor.py`
- `src/ripple/tools/builtin/agent_runner.py`
- `src/ripple/tools/builtin/ask_user.py`
- `src/ripple/tools/builtin/bash.py`
- `src/ripple/tools/builtin/read.py`
- `src/ripple/tools/builtin/search.py`
- `src/ripple/tools/builtin/write.py`
- `src/ripple/tools/builtin/task_create.py`
- `src/ripple/tools/builtin/task_get.py`
- `src/ripple/tools/builtin/task_list.py`
- `src/ripple/tools/builtin/task_update.py`
- `src/ripple/tools/builtin/gogcli_auth_status.py`
- `src/ripple/tools/builtin/gogcli_client_config_set.py`
- `src/ripple/tools/builtin/gogcli_login_start.py`
- `src/ripple/tools/builtin/gogcli_login_complete.py`
- `src/ripple/tools/builtin/gogcli_logout.py`
- `src/ripple/tools/builtin/notion_token_set.py`
- `src/ripple/tools/builtin/bilibili_auth_status.py`
- `src/ripple/tools/builtin/bilibili_login_start.py`
- `src/ripple/tools/builtin/bilibili_login_poll.py`
- `src/ripple/tools/builtin/bilibili_logout.py`
- `src/ripple/tools/builtin/music_identify.py`
- `src/ripple/permissions/levels.py`
- `src/ripple/permissions/manager.py`
- `tests/test_agent_runner_tool.py`
- `tests/test_skill_executor_agent_runner.py`

### Delete After Small Migration

These still have references, but the references are compatibility residue:

- `src/ripple/core/context.py`
  - Replace `ToolUseContext` and `ToolOptions` with a smaller session runtime context containing only model/provider, workspace root, sandbox session id, session runtime dir, user id, and sandbox manager.
- `src/ripple/skills/executor.py`
- `src/ripple/skills/skill_tool.py`
  - Keep skill parsing and manifest, remove skill execution as a Ripple tool.
- `src/ripple/tasks/`
- `src/ripple/utils/attachments.py`
- `SandboxConfig.tasks_file()`
- `SandboxConfig.task_outputs_dir()`
- `SandboxManager.setup_session()` creation of `task-outputs/`.
- `src/ripple/sandbox/command_runner.py`
  - It only preserves BashTool preparation semantics. Connector auth uses `execute_in_sandbox` directly, and Codex app-server has its own sandbox process wrapper.

### Keep Until Message/UI Refactor

These are stale in concept but entangled with current response/session shapes:

- `src/ripple/messages/cleanup.py`
- `ripple.messages.utils.extract_tool_use_blocks`
- `ripple.messages.utils.create_tool_result_message`
- `tool_use` / `tool_result` branches in `src/ripple/utils/token_counter.py`
- `tool_result` transcript handling in `src/interfaces/server/codex_chat.py`
- `ToolInvokeRequest` schema and `/v1/tools/invoke` 410 endpoint.

Reason: old persisted conversations or current frontend parsing may still contain tool-shaped blocks. Delete these only after deciding how much backward compatibility to keep for historical session transcripts.

### Frontend/Mobile Cleanup Deferred

The server can stay correct while UI is stale. Since UI is planned for a separate system rewrite, treat these as documentation for that work:

- `src/interfaces/web/src/app/page.tsx`
  - AskUser parsing.
  - old tool call rendering.
  - task panel state.
  - legacy permission request payload shape.
- `src/interfaces/web/src/lib/api.ts`
  - `tool_result`, task-created/task-updated/task-progress callbacks.
- `src/interfaces/web/src/lib/chatState.ts`
- `src/interfaces/web/src/components/TaskExecutionPanel.tsx`
- `src/interfaces/web/src/types/index.ts`
  - `ToolCall`, `AskUserData`, old `PermissionRequestData`, `TaskInfo`, `TaskProgress`.
- `src/interfaces/mobile/` and `src/interfaces/mobile/src/`
  - AskUser and permission assumptions from the old Ripple tool model.

### Docs To Refresh

- `docs/GOGCLI_GOOGLE_WEB_OAUTH_SETUP.md`
  - Contains an old `/v1/tools/invoke` example.
- `docs/MOBILE_APP_CHANGES.md`
  - Mentions AskUser behavior.
- `docs/superpowers/specs/2026-05-13-external-agent-runner-design.md`
  - Mentions normal tool permission path for destructive external agent launches.
- `docs/superpowers/plans/2026-05-12-ios-mobile-app.md`
  - Describes AskUser handling.
- `docs/superpowers/specs/2026-05-15-codex-only-execution-plane-design.md`
  - Keep as historical design unless you want a current-state architecture doc.

### Small Quality Cleanup

- `src/interfaces/server/schemas.py` currently defines `SessionDetailResponse` twice. Collapse to a single definition.
- `src/interfaces/server/routes.py` module docstring still describes `tools/invoke` as a normal endpoint. Update it to say the endpoint is deprecated and returns `410`.
- Remove old references to `Bash(...)`, `AskUser`, `TaskCreate`, and `PermissionManager` from comments and stale documentation after deleting the code.
- Ignore `__pycache__/` files. They are generated artifacts and should not be part of source cleanup.

## Task 1: Lock Current Codex-Only Invariants

**Files:**
- Modify: `tests/test_codex_only_runtime.py`
- Modify: `tests/test_legacy_loop_removed.py`

- [ ] **Step 1: Add a regression test that no source imports the old tool execution framework from server/runtime code**

Add this test to `tests/test_codex_only_runtime.py`:

```python
from pathlib import Path


def test_server_runtime_does_not_import_legacy_tool_execution():
    forbidden = (
        "from ripple.tools",
        "import ripple.tools",
        "PermissionManager",
        "execute_tool",
        "find_tool_by_name",
        "SkillTool",
    )
    roots = [Path("src/interfaces/server"), Path("src/ripple/agent_runners")]
    offenders: list[str] = []

    for root in roots:
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for term in forbidden:
                if term in text:
                    offenders.append(f"{path}:{term}")

    assert offenders == []
```

- [ ] **Step 2: Run the invariant tests**

Run:

```bash
uv run pytest tests/test_codex_only_runtime.py tests/test_legacy_loop_removed.py -q
```

Expected: pass before and after cleanup.

## Task 2: Remove Legacy Tool And Permission Source

**Files:**
- Delete: files listed in "High Confidence Delete".
- Modify: `src/ripple/sandbox/bilibili_gate.py`
- Modify: docs that mention deleted tool classes.

- [ ] **Step 1: Delete high-confidence legacy tool files**

Use `apply_patch` delete hunks for each file in the "High Confidence Delete" list.

- [ ] **Step 2: Delete tests that only exercise removed tools**

Delete:

```text
tests/test_agent_runner_tool.py
tests/test_skill_executor_agent_runner.py
```

- [ ] **Step 3: Remove stale source comments**

In `src/ripple/sandbox/bilibili_gate.py`, replace:

```python
# 任何变更请同步检查 ``orchestration.execute_tool`` 里的拦截分支。
```

with:

```python
# Connector-level Bilibili auth gates are enforced outside the removed Ripple tool executor.
```

- [ ] **Step 4: Scan for deleted runtime references**

Run:

```bash
rg -n "ripple\\.tools|PermissionManager|ToolRiskLevel|execute_tool|find_tool_by_name|SkillTool|AgentRunnerTool|AskUserTool|BashTool|TaskCreateTool" src tests -g '!src/interfaces/web/**'
```

Expected: no matches outside historical docs or frontend files intentionally deferred.

## Task 3: Replace ToolUseContext With A Runtime Context

**Files:**
- Create: `src/interfaces/server/runtime_context.py`
- Modify: `src/interfaces/server/sessions.py`
- Modify: `src/ripple/sandbox/storage.py`
- Delete: `src/ripple/core/context.py`

- [ ] **Step 1: Add a minimal runtime context dataclass**

Create `src/interfaces/server/runtime_context.py`:

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ripple.sandbox.manager import SandboxManager


@dataclass
class SessionRuntimeContext:
    model: str
    provider: str | None = None
    reasoning_effort: str | None = None
    cwd: Path = Path.cwd()
    workspace_root: Path | None = None
    sandbox_session_id: str | None = None
    session_runtime_dir: Path | None = None
    user_id: str | None = None
    sandbox_manager: SandboxManager | None = None
    sandboxed: bool = False


def serialize_runtime_context(context: SessionRuntimeContext | None) -> dict[str, Any] | None:
    if context is None:
        return None
    return {
        "model": context.model,
        "provider": context.provider,
        "reasoning_effort": context.reasoning_effort,
        "cwd": str(context.cwd),
        "workspace_root": str(context.workspace_root) if context.workspace_root else None,
        "sandbox_session_id": context.sandbox_session_id,
        "session_runtime_dir": str(context.session_runtime_dir) if context.session_runtime_dir else None,
        "user_id": context.user_id,
        "sandboxed": context.sandboxed,
    }
```

- [ ] **Step 2: Update session construction**

In `src/interfaces/server/sessions.py`, replace imports from `ripple.core.context` with `SessionRuntimeContext`. Replace `_create_session_context()` so it returns `SessionRuntimeContext` and stores `model`, `provider`, `reasoning_effort` directly instead of `ToolOptions`.

- [ ] **Step 3: Update context attribute reads**

Replace:

```python
session.context.options.model
session.context.options.provider
session.context.options.reasoning_effort
```

with:

```python
session.context.model
session.context.provider
session.context.reasoning_effort
```

- [ ] **Step 4: Remove old context module**

Delete:

```text
src/ripple/core/context.py
```

- [ ] **Step 5: Verify no old context references remain**

Run:

```bash
rg -n "ToolUseContext|ToolOptions|AbortSignal|permission_manager|ripple\\.core\\.context" src tests
```

Expected: no matches.

## Task 4: Remove Task/Todo Runtime

**Files:**
- Delete: `src/ripple/tasks/__init__.py`
- Delete: `src/ripple/tasks/manager.py`
- Delete: `src/ripple/tasks/models.py`
- Delete: `src/ripple/utils/attachments.py`
- Modify: `src/ripple/sandbox/config.py`
- Modify: `src/ripple/sandbox/manager.py`
- Modify: `src/ripple/utils/paths.py`

- [ ] **Step 1: Delete task runtime modules**

Delete:

```text
src/ripple/tasks/__init__.py
src/ripple/tasks/manager.py
src/ripple/tasks/models.py
src/ripple/utils/attachments.py
```

- [ ] **Step 2: Remove session task paths**

In `src/ripple/sandbox/config.py`, delete:

```python
def tasks_file(self, user_id: str, session_id: str) -> Path:
    """TaskCreate/Update/Get/List 工具的 todo 持久化文件"""
    return self.session_dir(user_id, session_id) / "tasks.json"

def task_outputs_dir(self, user_id: str, session_id: str) -> Path:
    """Session-scoped task output directory."""
    return self.session_dir(user_id, session_id) / "task-outputs"
```

- [ ] **Step 3: Stop creating `task-outputs/` for each session**

In `src/ripple/sandbox/manager.py`, remove:

```python
self.config.task_outputs_dir(user_id, session_id).mkdir(exist_ok=True)
```

- [ ] **Step 4: Update runtime directory documentation**

In `src/ripple/utils/paths.py`, remove `tasks.json` and `task-outputs/` from the documented `.ripple/` tree.

- [ ] **Step 5: Verify task runtime is gone**

Run:

```bash
rg -n "TaskCreate|TaskUpdate|TaskGet|TaskList|TaskManager|tasks_file|task_outputs_dir|task-outputs|utils\\.attachments|ripple\\.tasks" src tests -g '!src/interfaces/web/**'
```

Expected: no matches outside deferred frontend files and historical docs.

## Task 5: Remove SkillTool Execution Path

**Files:**
- Delete: `src/ripple/skills/executor.py`
- Delete: `src/ripple/skills/skill_tool.py`
- Modify: tests if references remain.

- [ ] **Step 1: Delete skill execution wrapper files**

Delete:

```text
src/ripple/skills/executor.py
src/ripple/skills/skill_tool.py
```

- [ ] **Step 2: Verify skill discovery still works**

Run:

```bash
uv run pytest tests/test_codex_only_runtime.py::test_codex_prompt_includes_skill_manifest -q
```

Expected: pass. This proves skill manifest/discovery still works without `SkillTool`.

- [ ] **Step 3: Verify no SkillTool references remain**

Run:

```bash
rg -n "SkillTool|execute_skill|skills\\.executor|skills\\.skill_tool" src tests
```

Expected: no matches outside historical docs.

## Task 6: Message Compatibility Cleanup

**Files:**
- Modify: `src/ripple/messages/types.py`
- Modify: `src/ripple/messages/utils.py`
- Modify: `src/ripple/messages/cleanup.py`
- Modify: `src/ripple/utils/token_counter.py`
- Modify: `src/interfaces/server/codex_chat.py`

- [ ] **Step 1: Decide compatibility policy for historical tool-shaped messages**

Use this rule unless the product direction changes:

```text
Keep read compatibility for existing tool-shaped messages in persisted transcripts.
Stop creating new Ripple tool-shaped messages.
```

- [ ] **Step 2: Remove creation helpers for new tool results**

Delete `create_tool_result_message()` and `extract_tool_use_blocks()` from `src/ripple/messages/utils.py` after all runtime references are gone.

- [ ] **Step 3: Keep or delete cleanup helpers based on session migration decision**

If historical sessions can be dropped or migrated, delete `src/ripple/messages/cleanup.py`. If historical sessions must remain readable, keep it until a transcript migration is written.

- [ ] **Step 4: Verify token counting still handles current messages**

Run:

```bash
uv run pytest tests/test_codex_chat_routes.py tests/test_codex_only_runtime.py -q
```

Expected: pass.

## Task 7: Server Schema And Route Polish

**Files:**
- Modify: `src/interfaces/server/schemas.py`
- Modify: `src/interfaces/server/routes.py`
- Modify: tests as needed.

- [ ] **Step 1: Collapse duplicate `SessionDetailResponse` definitions**

Replace the two class definitions with one:

```python
class SessionDetailResponse(SessionInfo):
    messages: list[dict[str, Any]] = []
    pending_question: str | None = None
    pending_options: list[str] | None = None
    pending_permission_request: dict[str, Any] | None = None
```

- [ ] **Step 2: Update route module docstring**

Replace the current docstring in `src/interfaces/server/routes.py` with:

```python
"""API 路由定义。

包含 chat completions、models、health、sessions、connectors、workspace、sandbox
以及 Codex app-server run 管理端点。旧 `/v1/tools/invoke` 保留为 410 兼容响应。
"""
```

- [ ] **Step 3: Verify schema tests**

Run:

```bash
uv run pytest tests/test_codex_only_runtime.py tests/test_workspace_routes.py tests/test_connector_routes.py -q
```

Expected: pass.

## Task 8: Documentation Refresh

**Files:**
- Modify: `docs/GOGCLI_GOOGLE_WEB_OAUTH_SETUP.md`
- Modify: `docs/MOBILE_APP_CHANGES.md`
- Modify: `docs/superpowers/specs/2026-05-13-external-agent-runner-design.md`
- Modify: `docs/superpowers/plans/2026-05-12-ios-mobile-app.md`

- [ ] **Step 1: Replace old `/v1/tools/invoke` examples**

In `docs/GOGCLI_GOOGLE_WEB_OAUTH_SETUP.md`, replace any `/v1/tools/invoke` example with connector routes:

```bash
curl -X POST "$API/v1/connectors/google_workspace/auth/start" \
  -H "Authorization: Bearer $RIPPLE_API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

- [ ] **Step 2: Replace AskUser wording**

For current docs, describe user interaction as Codex approval forwarding or connector auth responses. Do not describe `AskUser` as a server-side tool.

- [ ] **Step 3: Verify docs no longer advertise removed runtime**

Run:

```bash
rg -n "/v1/tools/invoke|AskUser|TaskCreate|PermissionManager|Bash\\(" docs
```

Expected: only historical design docs may match. If a current setup guide matches, update it.

## Task 9: Deferred UI Cleanup Notes

**Files:**
- Modify later with the planned UI rewrite.

- [ ] **Step 1: During UI rewrite, remove legacy task/tool state**

Remove old state and callbacks from:

```text
src/interfaces/web/src/app/page.tsx
src/interfaces/web/src/lib/api.ts
src/interfaces/web/src/lib/chatState.ts
src/interfaces/web/src/components/TaskExecutionPanel.tsx
src/interfaces/web/src/types/index.ts
```

- [ ] **Step 2: Replace old permission display shape**

Use Codex approval data fields:

```text
source
job_id
request_id
method
action
description
metadata
```

Keep the server field name `pending_permission_request` until the UI/API contract is intentionally renamed.

## Final Verification

Run all of these after the selected cleanup tasks:

```bash
uv run ruff format .
uv run ruff check .
uv run pytest -q
```

Expected:

```text
All checks passed
all pytest tests pass
```

If UI files are modified in the same cleanup session, also run:

```bash
cd src/interfaces/web
bun run lint
bun run build
```

## Recommended Execution Order

1. Task 1.
2. Task 2.
3. Task 3.
4. Task 5.
5. Task 4.
6. Task 7.
7. Task 8.
8. Task 6 only after deciding historical transcript compatibility.
9. Task 9 during the later UI rewrite.

This order removes the inactive execution framework first, then removes context/task residue, then cleans docs and UI assumptions.
