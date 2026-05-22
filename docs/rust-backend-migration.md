# Rust Backend Migration

Ripple 的 Rust 迁移目标是重写后端控制面，而不是把后端嵌进 Tauri 客户端。

## Target Shape

- `ripple-server` 是独立 Linux 后端服务。
- Web 和 Tauri App 都只是客户端，只调用 Ripple Server 的 `/v1` API。
- 后端继续保持多用户模型，`X-Ripple-User-Id` 是 user 隔离入口。
- sandbox 仍以 `user_id` 为单位，一个 user 拥有长期 workspace，多个 session 共享该 workspace。
- Codex app-server 仍是唯一执行面。Rust 后端负责启动、隔离、转发 JSON-RPC、收集事件、持久化状态。
- Skills 继续使用 Markdown/YAML frontmatter；Python skill pipeline 可以保留，由 Codex 在 user workspace 中执行。

## Current Rust Crate

The initial Rust backend lives at:

```text
crates/ripple-server/
```

Implemented in the current migration slice:

- Config loading from `config/settings.yaml` or `RIPPLE_CONFIG`.
- API key middleware for `/v1`.
- Multi-user `X-Ripple-User-Id` parsing and validation.
- Per-user sandbox directory creation under `.ripple/sandboxes/<user_id>/`.
- Session metadata and message store under `sessions/<session_id>/`, including list/get/create/delete/context-clear, caller system prompt persistence, first-user-message title extraction, accumulated token usage, and pending approval state.
- Workspace browse/search/preview/save/download/rename/upload/attachment APIs, including upload conflict reporting and the attachment response shape used by the web client.
- User profile/quota metadata APIs and basic workspace/session/run usage reporting.
- Document metadata CRUD APIs backed by per-user sandbox storage.
- Connector list/status shape for current built-in connectors.
- Notion token authorization/disconnect.
- Google Workspace assisted OAuth start/callback completion, account listing/disconnect through `gog`, plus the legacy `/v1/sandboxes/gogcli-accounts` alias.
- Feishu/Lark app config seeding, setup URL fallback, device-flow start/complete, status probing, and disconnect cleanup through `lark-cli`.
- Bilibili QR login start/complete, credential status with expiry filtering, disconnect cleanup, and nsjail readonly credential mount.
- Stateless `/v1/bilibili/qrcode.png` PNG rendering route.
- Codex app-server JSON-RPC provider with one trusted service process per user.
- `/v1/runs` for user-scoped Codex jobs, including durable `meta.json`, event replay, SSE follow, steer, and cancel.
- `/v1/chat/completions` bridge backed by the same Codex runner, including non-streaming and SSE streaming responses.
- Chat-backed Codex turns now use persistent app-server threads per session and persist `codex_thread_id` back into session metadata, so follow-up turns can resume Codex-side context instead of always starting an ephemeral thread.
- Chat prompt construction now includes Python-parity guardrails, persistent-thread conversation state, and non-image workspace attachment metadata.
- Chat input parsing now handles OpenAI `file` blocks, maps workspace images to Codex `localImage` input, validates workspace file paths, and persists normalized user content for attachments.
- Chat SSE now forwards Codex plan/runtime/tool/usage events consumed by the web client, filters commentary agent-message deltas, falls back to completed agent-message text when needed, persists live plan progress into session detail, and uses the frontend-recognized error/heartbeat shape.
- Non-streaming chat responses now return the latest Codex token usage observed from app-server events instead of a permanently empty usage object.
- Chat completions now persist observed token usage into session usage metadata, so `/v1/sessions/{session_id}/usage` reports accumulated input/output tokens instead of fixed zeroes.
- Chat SSE now forwards Codex image view/generation events and imports generated PNGs into the current user workspace when Codex returns a saved path or base64 image payload.
- Chat-side connector auth interception and polling for Notion, Google Workspace, Feishu/Lark, and Bilibili, including SSE auth events and automatic resume after completion.
- Connector status/accounts routes now match Python's missing-sandbox 404 behavior, and status/auth routes clear or mark authorized matching pending connector-auth state across the current user's sessions after successful authorization.
- Codex approval bridge from app-server notifications to session pending approval and `/sessions/{session_id}/permissions/resolve`, including post-resolve session status finalization after the Codex job reaches a terminal state.
- `/v1/sessions/{session_id}/stop` now cancels the active Codex run for that user/session and marks session state as cancelled.
- `/v1/sessions/{session_id}` deletion now cancels an active queued/running session job before removing the session directory, and in-flight chat finalization will not recreate a deleted session.
- `/v1/sandboxes` deletion now stops the current user's live Codex jobs and tears down that user's app-server process before removing the sandbox directory.
- `/v1/sessions/{session_id}/context/clear` now rejects active sessions and clears pending question/approval/connector/schedule state, Codex thread id, and plan progress.
- `/v1/sessions/{session_id}/suspend`, `/resume`, `/sessions/suspended`, and Python-compatible `GET /sessions/{session_id}` auto-resume now perform persisted session state transitions instead of fixed compatibility responses.
- The Rust server now starts a session maintenance loop that auto-suspends idle in-memory sessions and removes expired suspended session directories.
- Workspace search now supports Python-compatible `file_type` filtering for code, markdown, text, and image files.
- User quota enforcement now blocks session creation, Codex run creation, schedule-triggered runs, chat schedule extraction runs, workspace saves/uploads, and generated-image imports at write/start boundaries.
- Chat entrypoints now use the user-level sandbox lock for start-time critical sections and reject new chat turns while the same session is already queued/running.
- Codex jobs now use a per-user execution lock: new jobs start as `queued`, switch to `running` only after acquiring the current user's execution slot, and therefore keep chat, `/v1/runs`, schedule triggers, and schedule extraction from concurrently mutating the same user workspace.
- Schedule CRUD, schedule run history, run-now, nullable-field clearing on PATCH, run-now error writeback, and a background due-schedule trigger loop.
- Chat-side schedule creation now handles pending confirmation/cancellation, Codex structured extraction, configurable extraction timeout, clarification/proposal/created/cancelled events, and persists confirmed schedules through the Rust schedule store.
- Deprecated `/v1/tasks` compatibility routes now return the same explicit 410 guidance as Python.
- Codex managed permissions profile injection for the user workspace and deny-read rules around service Codex auth paths.
- Codex process env for uv/node caches, package mirrors, Notion token, and gog keyring password.
- Internal Google Workspace and Feishu/Lark connector CLI commands now run through the user nsjail config and sandbox-mounted `/opt/...` binaries instead of directly executing host binaries, including the long-lived Feishu setup URL fallback process.
- Skill manifest rendering from shared and workspace skills.
- Shared skills moved to `src/skills/*`; tracked sample config and Rust defaults now point at the new location.
- Skill docs with executable helper scripts now use paths relative to their own skill directory, avoiding stale local absolute paths.
- `scripts/smoke-rust-server.sh` starts a temporary Rust server with an isolated config and validates `/health`, authenticated `/v1/models`, and session creation for Rust-first local startup.
- Rust route smoke coverage now exercises the full Axum router for `/health`, API key enforcement, session creation, session usage/title/system-prompt metadata, session stop/suspend/GET auto-resume/resume/context-clear, deletion of a running chat session without session resurrection, workspace save/search/upload conflict/overwrite/preview/rename/download/attachment upload, schedule CRUD/list/runs/PATCH null clearing, connector missing-sandbox/status/accounts/auth pending-state cleanup, Google/Feishu short connector commands through fake nsjail-mounted CLI binaries, Codex approval resolve, chat-side schedule proposal/confirmation, control-plane chat SSE for connector auth and schedule cancellation, fake Codex app-server completion through `/v1/runs`, same-user run queueing/serialization, cancellation of a queued run before it executes, sandbox teardown cancellation of live runs, fake Codex non-streaming and SSE `/v1/chat/completions`, fake Codex chat SSE notification mapping for plan/runtime/tool/image/usage events with generated-image workspace import, schedule `run-now`, schedule run-now error writeback, due schedule triggering, and deprecated `/v1/tasks` behavior. The smoke suite also includes a real TCP listener startup check for `/health` when the local test environment permits binding a port.

Not implemented yet:

- End-to-end hardening for chat-side schedule creation with real Codex extraction output and older client UI flows.
- End-to-end hardening for connector CLI auth/status flows in a real nsjail runtime.

## Execution Plan

Priority order for the remaining Rust migration:

1. Stabilize `/v1/chat/completions` as the primary user-facing path.
   - Keep Codex persistent thread continuity aligned with Python.
   - Chat prompt context, attachment handling, SSE plan/runtime/tool/image/usage events, assistant message filtering/fallback, and non-stream usage parity are in place.
   - Route-level smoke coverage now exercises control-plane chat SSE for connector auth/schedule cancellation without external Codex, fake Codex approval resolve, fake Codex non-streaming and SSE completion with persistent thread reuse, usage persistence, title extraction, and caller system prompt persistence, plus fake Codex notification mapping for plan/runtime/tool/image/usage events and generated-image workspace import.
   - Remaining work: add broader end-to-end route fixtures around real Codex chat event streams and real uploaded image/file attachment turns.

2. Port chat-side schedule creation.
   - Initial Rust port is in place: intent detection, structured extraction, clarification, confirmation, cancellation, and `pending_schedule_request` handling.
   - Reuses Rust schedule CRUD for persistence after confirmation.
   - Route-level smoke coverage confirms fake Codex structured extraction can propose schedules and pending schedule confirmation can create schedules without starting Codex.
   - Remaining work: e2e coverage against real Codex extraction output and older client UI flows.

3. Finish session lifecycle parity.
   - Active chat jobs can now be cancelled by `/sessions/{id}/stop`, session deletion, and user sandbox deletion.
   - Context clear, basic suspend/resume/list-suspended state transitions, GET auto-resume for suspended sessions, automatic idle suspension, suspended-session retention cleanup, and deleted-session resurrection protection are in place.
   - Route-level smoke coverage now exercises stop/suspend/GET auto-resume/resume/list-suspended/context-clear, live run cancellation during sandbox teardown, and deletion of a running chat session.
   - Remaining work: route-level tests for automatic maintenance behavior with controlled time.

4. Enforce user quotas and concurrency consistently.
   - Core quota checks are now applied at session/run/workspace write/start boundaries.
   - Chat start critical sections now use the user-level sandbox lock and reject concurrent turns for the same running session.
   - Codex job execution is now serialized per user across chat, `/v1/runs`, and schedule-triggered work.
   - Route-level smoke coverage confirms queued `/v1/runs` can be cancelled before execution and do not emit runner events after the active user run completes.
   - Remaining work: add broader stress tests for steering/approval while jobs are queued behind an active user run.

5. Close sandbox and connector execution gaps.
   - Rust nsjail mount/env generation covers connector CLI roots, caches, package mirrors, and credential-derived env.
   - Connector auth completion now clears matching pending session auth state.
   - Google Workspace and Feishu/Lark short commands and the long-lived Feishu setup URL fallback now execute through nsjail using sandbox-mounted CLI binaries.
   - Route-level smoke coverage confirms missing-sandbox status/accounts behavior, authorized connector actions update matching pending session auth state, and Google/Feishu short commands are invoked through fake nsjail with `/opt/...` sandbox binary paths.
   - Remaining work: e2e verification with real nsjail and connector CLIs.

6. Deprecated API compatibility.
   - `/v1/tasks` now returns the explicit Python-compatible 410 response.

7. Add parity tests before switching production traffic.
   - Basic route smoke coverage for current web client APIs, session lifecycle, workspace save/search/upload/download/rename/attachments, connector status/accounts/auth pending-state cleanup, fake nsjail connector CLI boundaries, Codex approval resolve, schedule CRUD/PATCH/run-now, chat-side schedule proposal/confirmation, control-plane chat SSE, fake Codex chat completion, fake Codex chat SSE runtime/tool/image notification mapping, and fake Codex runs is in place.
   - Remaining work: broaden route shape fixtures for real Codex chat streaming, real connector auth/status boundaries, and controlled-time session maintenance.
   - Schedule chat state-machine tests.
   - Connector auth flow tests with mocked CLI/HTTP boundaries.

## Verification

```bash
cargo check -p ripple-server
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
```

Current Rust test coverage includes unit tests plus `tests/api_smoke.rs`, which builds the complete Axum router and verifies core control-plane routes, session lifecycle routes including GET auto-resume, deletion of a running chat session without recreating it, session usage metadata, workspace save/search/upload/download/rename/attachment APIs, schedule CRUD/PATCH/run-now, due schedule triggering, connector missing-sandbox/status/accounts behavior, connector pending-auth cleanup, fake nsjail execution of Google/Feishu short connector CLI commands through `/opt/...` sandbox binary paths, Codex approval resolve, chat-side schedule proposal/confirmation, control-plane chat SSE without external Codex or connector services, `/v1/chat/completions` non-streaming and SSE completion through a local fake Codex app-server fixture, chat SSE mapping for plan/runtime/tool/image/usage notifications with generated-image workspace import, `/v1/runs` completion through the same fixture, same-user `/v1/runs` queueing behind an active run, queued run cancellation before execution, and sandbox teardown cancellation of live runs. The same smoke file also starts the Rust server on a real TCP listener and checks `/health` when the test sandbox allows local port binding.

Python FastAPI remains the production backend until the Rust Codex runner and connector auth flows reach parity.
