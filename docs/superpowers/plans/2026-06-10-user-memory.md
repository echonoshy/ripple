# User Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user Codex native memory to Ripple with isolated Markdown/SQLite storage, service auth symlink reuse, and settings-page memory controls.

**Architecture:** Each `X-Ripple-User-Id` gets a private `sandboxes/<user_id>/codex-home` used as Codex `CODEX_HOME` for app-server state and memory. The per-user `codex-home/auth.json` is a validated symlink to the service Codex auth file, while permissions deny both the per-user Codex home and service auth paths. Ripple exposes `/v1/memory/*` APIs for settings, read-only summary, and reset without exposing raw Codex filesystem paths or creating a separate editable Ripple memory store.

**Tech Stack:** Rust 1.77.2, axum, serde/serde_json, tokio, Codex app-server JSON-RPC, file-backed sandbox state.

---

### Task 1: Per-User Codex Home Foundation

**Files:**
- Modify: `crates/ripple-server/src/sandbox.rs`
- Modify: `crates/ripple-server/src/codex/permissions.rs`

- [ ] Add tests proving `SandboxManager::codex_home_dir("alice")` returns `sandboxes/alice/codex-home` outside `workspace/`.
- [ ] Add tests proving `ensure_user_codex_home_auth_link("alice")` creates `codex-home/auth.json` as a symlink to `.ripple/codex-service-home/auth.json`.
- [ ] Add tests proving missing service auth causes auth-link validation to fail.
- [ ] Add tests proving the permission profile denies the current user's `codex-home`, the service Codex home, and the resolved service auth path.
- [ ] Implement the sandbox helpers and permission changes.
- [ ] Run `cargo test -p ripple-server sandbox codex::permissions`.

### Task 2: App-Server Uses Per-User CODEX_HOME

**Files:**
- Modify: `crates/ripple-server/src/codex/app_server.rs`

- [ ] Add tests for app-server session construction or helper functions proving the selected Codex home is per-user, not `config.codex_home_path()`.
- [ ] Add tests for thread config proving memory feature overrides are injected from request metadata.
- [ ] Add per-user Codex home field to `CodexAppServerSession`.
- [ ] Ensure app-server startup validates the auth symlink before spawning Codex.
- [ ] Pass per-user Codex home to compact/read thread sessions as well as normal runs.
- [ ] Add memory config to thread config: `features.memories`, `memories.use_memories`, `memories.generate_memories`, `memories.dedicated_tools=false`, `memories.disable_on_external_context=false`.
- [ ] Run focused app-server tests.

### Task 3: Memory Settings and API

**Files:**
- Create: `crates/ripple-server/src/api/memory.rs`
- Modify: `crates/ripple-server/src/api/mod.rs`
- Modify: `crates/ripple-server/src/sandbox.rs`
- Modify: `crates/ripple-server/src/jobs.rs`
- Modify: `crates/ripple-server/src/codex/app_server.rs`

- [ ] Add tests for loading default per-user memory settings.
- [ ] Add tests for updating settings with `enabled`, `use_memories`, and `generate_memories`.
- [ ] Add tests for reading summary only from the current user's memory root.
- [ ] Add `GET /v1/memory/status`.
- [ ] Add `GET /v1/memory/summary`.
- [ ] Add `PATCH /v1/memory/settings`.
- [ ] Add `POST /v1/memory/reset` requiring confirmation and calling Codex `memory/reset` for the current user's app-server home.
- [ ] Run focused API and sandbox tests.

### Task 4: Backend Memory Safeguards

**Files:**
- Modify: `crates/ripple-server/src/sessions.rs`
- Modify: `crates/ripple-server/src/api/sessions.rs`
- Modify: `crates/ripple-server/src/api/chat.rs`
- Modify: `crates/ripple-server/src/jobs.rs`

- [ ] Add `memory_disabled` to `SessionRecord` with serde default.
- [ ] Add tests proving new sessions default to memory enabled.
- [ ] Add tests proving session memory disable persists and rejects another user's session.
- [ ] Add `POST /v1/sessions/:session_id/memory/disable`.
- [ ] If a session has a Codex thread id, call Codex `thread/memoryMode/set` with `disabled`.
- [ ] Add optional `temporary` to chat requests; temporary runs should not use or generate memory and should not create persistent Codex thread state.
- [ ] Pass memory metadata from chat to job creation.

### Task 5: Settings Page Memory Surface

**Files:**
- Modify: `app/src/lib/api.ts`
- Modify: `app/src/types/index.ts`
- Modify: `app/src/components/workbench/SettingsPage.tsx`
- Modify: `app/src/i18n/index.tsx`
- Test: `app/src/lib/api.test.ts`
- Test: `app/src/components/workbench/SettingsPage.test.tsx`

- [ ] Add API tests for `GET /memory/status`, `GET /memory/summary`, `PATCH /memory/settings`, and `POST /memory/reset`.
- [ ] Add settings page tests proving the UI shows Memory, Use memories, Update memories automatically, Memory summary, and Clear memory.
- [ ] Add settings page tests proving the UI does not expose manual add/edit memory controls.
- [ ] Implement `MemoryStatus`, `MemorySummary`, and `MemorySettingsPatch` client types.
- [ ] Implement memory API helpers with camelCase client fields and snake_case backend payloads.
- [ ] Add a Settings page Memory section with default-on switches, read-only summary viewing, and clear-all confirmation.
- [ ] Add Chinese and English i18n strings.
- [ ] Run `bun test src/lib/api.test.ts src/components/workbench/SettingsPage.test.tsx`.

### Task 6: Verification

**Files:**
- Modify as needed based on compile/test output.

- [ ] Run `cargo fmt -p ripple-server`.
- [ ] Run focused tests for sandbox, permissions, app-server helpers, sessions, and memory API.
- [ ] Run `cargo check -p ripple-server`.
- [ ] Run `cargo test -p ripple-server` if focused tests and check pass.
- [ ] Run `bun run lint` and `bun run build` in `app/`.
- [ ] Update the design doc only if implementation materially changes the accepted design.
