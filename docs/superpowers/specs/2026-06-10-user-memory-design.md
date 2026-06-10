# Ripple User Memory Design

## Context

Ripple needs long-term user memory for Codex-backed chat sessions. The memory should help future agent runs understand durable user preferences, ongoing project context, known workflow constraints, and reusable task knowledge without requiring the user to repeat them.

Codex app-server already provides an experimental native memory system. It stores memory under `CODEX_HOME` using Markdown files and SQLite state, and it can generate memories from prior Codex rollouts. Ripple should use this native capability where possible, but Ripple is a multi-user control plane, so memory isolation must follow Ripple's `X-Ripple-User-Id` sandbox model rather than Codex's default single-user `CODEX_HOME` assumption.

The current Ripple service uses a service-level Codex home, `.ripple/codex-service-home`, for server Codex auth. Enabling native Codex memory directly on that shared home would mix memories across users. The design therefore introduces a per-user Codex home for state and memory while reusing service auth through a controlled `auth.json` symlink.

## Goals

- Provide each Ripple user with isolated long-term Codex memory.
- Keep using the upstream Codex app-server binary without local upstream patches.
- Preserve service-level Codex authentication and avoid per-user Codex login.
- Prevent Codex auth, memory files, and memory SQLite data from being exposed through user workspace APIs or model-facing tools.
- Let users control whether memory is used, generated, viewed, or reset from personal settings.
- Start with conservative memory behavior that avoids recording sensitive connector/auth flows.
- Keep Web, Tauri, and mobile clients on the existing `/v1` API boundary.

## Non-Goals

- Do not modify upstream Codex app-server.
- Do not replace Codex native memory with a fully custom vector database or external memory service in this phase.
- Do not expose raw `CODEX_HOME` paths to clients.
- Do not promise exact item-level CRUD over every Codex-generated memory file in the first phase.
- Do not store service Codex auth inside user workspaces.
- Do not use ChatGPT product memory as Ripple's storage or isolation mechanism.

## Memory Semantics

Ripple memory is user-scoped agent memory, not a full transcript archive.

Memory may include:

- Stable user preferences.
- Durable project context, such as "the user is building a multi-user Codex control plane".
- Repo and workflow conventions.
- Reusable commands, paths, verification habits, and failure shields.
- Explicit user requests to remember or forget a preference, expressed naturally in chat and handled by Codex.

Memory should not include:

- API keys, OAuth tokens, cookies, passwords, or connector credentials.
- Temporary search results, live metrics, one-off logs, or short-lived operational facts.
- Raw connector outputs unless the user explicitly asks to remember a durable takeaway.
- Sensitive auth/setup flows such as OAuth, QR login, token paste, account linking, or credential repair.
- Large raw outputs that should instead remain in session history or workspace artifacts.

Codex native extraction remains model-driven, so Ripple controls memory by gating which threads are eligible, which memory features are enabled, and which management operations users can trigger.

## Storage Layout

Each user gets a private Codex home under that user's sandbox:

```text
.ripple/
  codex-service-home/
    auth.json
  codex-runtime/
    users/
      <user_id>/
        sqlite/
          state_5.sqlite
          logs_2.sqlite
          goals_1.sqlite
          memories_1.sqlite
  sandboxes/
    <user_id>/
      workspace/
      codex-home/
        auth.json -> ../../../codex-service-home/auth.json
        memories/
          memory_summary.md
          MEMORY.md
          raw_memories.md
          rollout_summaries/
          skills/
          extensions/ad_hoc/notes/
```

Only `auth.json` may be a symlink. Memory files and SQLite databases must be real files under the current user's `codex-home`.

`codex-home` must not live inside `workspace/`. Workspace file APIs, document APIs, and upload/download paths must never serve files from `codex-home`.

## Auth Strategy

Ripple cannot modify upstream Codex to split auth home from state home. The accepted approach is:

- Run each user's Codex app-server with `CODEX_HOME` set to the user's `codex-home`.
- Create `codex-home/auth.json` as a symlink to the service-level `.ripple/codex-service-home/auth.json`.
- Keep service auth owned by the Ripple server account and outside all user workspaces.
- Deny model/tool reads of both the user `codex-home` and the service Codex home.
- Exclude `CODEX_HOME` from shell tool environments.

Startup must validate the symlink:

- The user `auth.json` path must be a symlink.
- The symlink target must resolve to the configured service auth file.
- The target must not resolve inside any user sandbox or workspace.
- The service auth file must exist before memory-enabled app-server startup.

User sandbox deletion and backup/export must not follow this symlink.

## Codex Memory Configuration

Initial app-server configuration for memory-enabled users:

```text
features.memories = true
memories.use_memories = true
memories.generate_memories = true
memories.dedicated_tools = false
memories.disable_on_external_context = false
```

Rationale:

- `use_memories` lets Codex use prior per-user memory.
- `generate_memories` lets normal eligible chat sessions contribute future memory.
- `dedicated_tools = false` avoids exposing direct memory tools to the model in the first rollout.
- `disable_on_external_context = false` keeps connector/web-backed user tasks eligible for extraction. Ripple keeps its own control-plane prompt out of user input by sending stable instructions as `baseInstructions` and dynamic context as `additionalContext`.

Ripple should not build a separate editable memory store. If the user says "remember this" in chat, Codex app-server should decide whether and how to fold that durable instruction into native memory.

## User Controls

Ripple should expose user-facing memory controls through Ripple-owned `/v1` APIs rather than raw Codex JSON-RPC. The product boundary is that Codex manages memory content and retrieval, while Ripple manages settings, visibility, and reset.

Required controls:

- View memory status for the current user.
- Enable or disable using existing memory.
- Enable or disable generating new memory.
- Show a readable, read-only memory summary derived from the current user's `memory_summary.md` and `MEMORY.md`.
- Clear all memory for the current user.

Optional backend safeguards that do not need first-phase UI:

- Mark a sensitive internal/session thread as not eligible for future memory.
- Start an internal or temporary chat that neither uses existing memory nor generates new memory.

First phase must not present raw Markdown files as editable documents, and must not provide manual add/edit/delete memory forms. Users may influence memory through normal chat phrasing such as "remember ..."; Codex app-server remains responsible for filtering and organizing memory.

## API Direction

Add Ripple-level endpoints that resolve the current user from `X-Ripple-User-Id`:

```text
GET    /v1/memory/status
GET    /v1/memory/summary
PATCH  /v1/memory/settings
POST   /v1/memory/reset
```

Response shapes should be stable and client-oriented:

```json
{
  "enabled": true,
  "use_memories": true,
  "generate_memories": true,
  "summary_available": true,
  "last_updated_at": "2026-06-10T00:00:00Z"
}
```

`/v1/memory/reset` must only clear the current user's per-user Codex memory. It must not delete service auth or any other user's memory.

Session memory disable, if used by backend safeguards, should map to Codex app-server `thread/memoryMode/set` for the current user's Codex thread id. It must reject session ids that do not belong to the current user. The first UI does not expose this as a per-session prompt or menu action.

## Backend Components

Expected backend changes:

- Add a sandbox helper for `sandboxes/<user_id>/codex-home`.
- Ensure the per-user Codex home exists before starting app-server.
- Ensure `auth.json` symlink exists and passes validation.
- Pass the per-user Codex home into `CodexAppServerSession` instead of always using global `config.codex_home_path()`.
- Update permission config so each thread denies:
  - the current user's `codex-home`,
  - the service Codex home,
  - the resolved service `auth.json`,
  - all other user sandboxes.
- Keep excluding `CODEX_HOME` from shell environments.
- Add Ripple memory APIs that only operate on the current user's Codex home.
- Ensure connector auth/status CLI flows continue using the intended service Codex home semantics where required.

## Privacy and Safety

Memory is user data. It must follow the same isolation boundary as the user sandbox.

Required guarantees:

- No cross-user memory reads or writes.
- No memory generated from another user's threads.
- No client-provided path can select a memory root.
- No raw service auth is copied into user workspaces.
- Memory reset cannot follow symlinked memory roots.
- Logs must avoid printing memory contents or auth contents.
- Memory summary APIs should redact obvious secrets before returning content.
- Sensitive control-plane flows should set memory generation off for the session or mark the thread memory mode disabled.

## Migration

Existing Codex thread ids created under the shared service `CODEX_HOME` are not automatically portable to per-user Codex homes.

Migration policy:

- New memory-enabled sessions use per-user Codex homes.
- Existing Ripple sessions with stored Codex thread ids may either continue without native memory until recreated or be invalidated for Codex resume with a clear fallback message.
- Do not copy shared `state_5.sqlite`, `memories_1.sqlite`, or `memories/` into per-user homes.
- Do not attempt to infer user ownership from old shared Codex state.

## Rollout Plan

Phase 1: Isolation foundation

- Add per-user Codex home creation.
- Add controlled `auth.json` symlink creation and validation.
- Start app-server with per-user `CODEX_HOME`.
- Update permission denies and tests.
- Keep memory disabled by default until isolation tests pass.

Phase 2: Native memory enablement

- Enable Codex native memory for a test user or config-gated cohort.
- Use defaults with `dedicated_tools = false` and `disable_on_external_context = false`.
- Add user-level status and reset APIs.
- Add session-level memory disable.

Phase 3: Product controls

- Add client settings for memory on/off, read-only summary viewing, and reset.
- Add read-only memory summary UI.
- Add explicit remember/forget flows after validating Codex ad-hoc notes behavior.

## Testing

Backend tests:

- Per-user Codex home path is deterministic and outside `workspace/`.
- `auth.json` symlink points only to configured service auth.
- Deleting or resetting a user sandbox does not follow the auth symlink.
- App-server for user A and user B use different `CODEX_HOME` values.
- User A memory reset does not affect user B memory files or SQLite.
- Permission profile denies user `codex-home`, service Codex home, and resolved auth path.
- Shell environment policy excludes `CODEX_HOME`.
- Session memory disable rejects sessions from another user.
- Temporary chat does not use or generate memory.

Manual verification:

- Start two users, create durable project context in each, and confirm memory files stay separated.
- Reset memory for one user and confirm the other user's memory remains intact.
- Run a connector auth flow and confirm the resulting thread is not eligible for memory.
- Confirm workspace file browsing cannot access `codex-home`.
- Confirm service auth remains valid after multiple user app-server starts.

## Acceptance Criteria

- Memory is never stored in the shared service Codex home.
- Every user has independent Markdown memory files and memory SQLite data.
- Service auth is reused by symlink without being copied into user workspaces.
- Users can disable memory use, disable memory generation, reset memory, and exclude a session.
- Sensitive connector/auth flows are not persisted as memory.
- The implementation works with upstream Codex app-server without patches.
