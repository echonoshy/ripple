# Codex-Only Execution Plane Design

## Summary

Ripple will keep its control-plane responsibilities and remove its own agent execution plane. Codex app-server becomes the only component that performs agent work such as reading files, writing files, running shell commands, using CLI tools, following skills, and completing multi-step tasks.

Ripple remains responsible for user identity, session lifecycle, sandbox lifecycle, connector authorization, credential isolation, Codex app-server process management, job state, event persistence, and API boundaries.

## Goals

- Make Codex app-server the single trusted execution plane for user tasks.
- Keep Ripple as the multi-user control plane for `user_id`, sessions, sandboxes, connectors, credentials, and jobs.
- Preserve public skills and user-provided skills by turning skills into discoverable Codex resources instead of Ripple tools.
- Add a Codex approval bridge so Codex permission or approval requests can be surfaced through Ripple and resolved by the user.
- Remove or deprecate Ripple's own model-facing execution tools, including Bash, Read, Write, Search, SkillTool, Task tools, AskUser, AgentRunnerTool, and the old PermissionManager flow.

## Non-Goals

- This design does not redesign the current web UI. UI changes can follow after the server architecture is clean.
- This design does not remove connector APIs, sandbox APIs, session APIs, or Codex run APIs.
- This design does not require Ripple to interpret individual shell commands or file edits for risk. Codex owns execution decisions inside the sandbox.
- This design does not change the basic per-user sandbox model.

## Current State

Ripple currently has two execution concepts:

- Codex app-server, which already powers `/v1/chat/completions` and `/v1/runs`.
- Ripple tools, including Bash, Read, Write, Search, SkillTool, Task tools, AskUser, and AgentRunnerTool.

The old agent loop has already been removed, but the Ripple tool layer still exists in prompts, route schemas, permission handling, tests, and some skill instructions. This creates overlapping responsibility: Codex is the real executor, while Ripple still contains a partially active tool execution model.

## Target Architecture

### Control Plane: Ripple

Ripple keeps these responsibilities:

- API key verification and request context logging.
- `X-Ripple-User-Id` parsing and validation.
- Session creation, retrieval, persistence, suspension, resume, stop, and deletion.
- Per-user sandbox creation, summary, teardown, quota reporting, and nsjail configuration.
- Per-user connector authorization, status, account listing, disconnect, and OAuth callback handling.
- Per-user credential storage and sandbox injection.
- Codex app-server pool management, job state, event files, output files, cancellation, and steering.
- Workspace browsing and preview endpoints as management/debugging APIs.
- Skill registry and skill manifest generation.

### Execution Plane: Codex

Codex app-server owns:

- Reading and writing workspace files.
- Running shell commands.
- Searching code and documents.
- Applying skills by reading skill files and resources.
- Running connector CLIs such as `lark-cli`, `gog`, `ntn`, and Bilibili pipeline scripts.
- Making task plans and executing multi-step work.
- Requesting approval when it needs user confirmation.

Ripple should start Codex with enough sandbox capability for trusted execution:

- `sandbox_type: workspace-write`
- `network_access: true`
- writable root set to the current user's `/workspace` or requested workspace subdirectory
- current user connector credentials injected through the sandbox environment and mounts

## Retained Server APIs

The following API areas remain part of Ripple:

- `/v1/chat/completions`
- `/v1/models`
- `/v1/info`
- `/v1/sessions*`
- `/v1/sandboxes*`
- `/v1/runs*`
- `/v1/connectors*`
- `/v1/workspace*`
- connector-specific callback routes such as `/v1/sandboxes/gogcli/oauth/callback`

The retained APIs should describe Ripple as a control plane, not as a tool execution engine.

## Deprecated Or Removed Server APIs

The following should be removed or explicitly deprecated:

- `/v1/tools/invoke`
- `/v1/sandbox/schedules*`
- session permission resolve semantics that replay Ripple tool calls
- any API response field that is only meaningful for Ripple's old tool execution flow, unless it is reused for Codex approval forwarding

If backward compatibility is needed briefly, `/v1/tools/invoke` can return a clear 410-style error explaining that agent execution is handled by Codex app-server.

If backward compatibility is needed briefly, `/v1/sandbox/schedules*` can return a clear 410-style error explaining that scheduling should be owned by an external scheduler that calls `/v1/runs`.

## Codex Approval Bridge

Ripple needs a new bridge for Codex-originated permission or approval requests.

## Ripple Permission Boundary

Ripple should no longer make command-level execution decisions such as whether a Bash command, file write, search, or skill execution is allowed. Those decisions belong to Codex app-server and its sandbox policy.

Ripple still owns control-plane authorization and ownership checks:

- The caller may only access sessions, jobs, sandboxes, connector accounts, credentials, and workspace views for the current `user_id`.
- Connector APIs decide whether a user has authorized a connector and whether credentials should be created, refreshed, injected, or removed.
- Sandbox APIs decide whether a user sandbox can be created, summarized, or destroyed. Existing protections such as refusing to destroy the `default` user sandbox remain valid.
- Destructive Ripple control-plane operations still require explicit confirmation where they already do, especially connector disconnects and sandbox deletion.
- Codex-originated approval requests are brokered by Ripple so the user can allow, deny, cancel, or steer the pending Codex action.

In other words, Ripple's permission layer moves from "can this model call this tool with these arguments" to "is this user allowed to manage this Ripple resource, and how do we route Codex approval decisions".

### Event Capture

`CodexAppServerAgentProvider._collect_turn()` should inspect Codex notifications in addition to writing them to `events.jsonl`.

When a notification represents an approval request, Ripple should record a pending request with enough information to resume the turn:

```json
{
  "source": "codex",
  "job_id": "agent-...",
  "user_id": "alice",
  "session_id": "srv-...",
  "thread_id": "...",
  "turn_id": "...",
  "request_id": "...",
  "action": "...",
  "description": "...",
  "metadata": {}
}
```

The exact notification shape and response method must be confirmed against the Codex app-server protocol before implementation. The bridge should isolate that protocol-specific parsing in one module so future Codex protocol changes do not leak into route handlers.

### State Model

Ripple should support a Codex approval pending state for both chat sessions and raw `/v1/runs` jobs.

For chat sessions:

- `session.status` becomes `awaiting_codex_approval`.
- `session.pending_permission_request` stores the Codex approval request.
- Streaming pauses or emits a structured event indicating approval is required.

For `/v1/runs`:

- The job remains visible through `/v1/runs/{job_id}`.
- The job info includes a pending approval field or a related status endpoint.
- The run can be approved, rejected, cancelled, or steered.

### Resolution

The existing permission resolution route can be repurposed only if it no longer replays Ripple tools. Resolution should dispatch by `source`:

- `source="codex"` forwards allow or deny to Codex app-server.
- old Ripple tool replay support should be removed with the tool execution layer.

If Codex app-server provides explicit approval methods, Ripple should call those methods. If it only supports turn steering, Ripple may send a structured `turn/steer` message describing the user's approval or denial.

## Skills

Skills remain a first-class Ripple capability, but not as executable Ripple tools.

### Skill Registry

Ripple keeps a skill registry that loads:

- shared skills from `skills.shared_dirs`
- user skills from `/workspace/skills/`

Workspace skills may override shared skills with the same name. The manifest should make the source visible so users and developers can understand which skill is active.

### Skill Manifest

Each Codex turn should include a compact skill manifest instead of embedding full skill content. The manifest should include:

- skill name
- description
- source: `shared` or `workspace`
- sandbox-visible path to `SKILL.md`
- optional `when_to_use`
- optional connector or CLI hints when available

Codex reads the actual `SKILL.md`, references, scripts, and templates itself when it decides a skill is relevant.

### Stable Paths

Shared skills should be mounted into a stable sandbox path such as:

```text
/opt/ripple/skills/shared/
```

User skills remain at:

```text
/workspace/skills/
```

This avoids teaching Codex host filesystem paths and makes skill instructions portable across deployments.

### Skill Metadata Changes

The `allowed-tools` field becomes obsolete because Ripple no longer gates model tools. It can remain in legacy skill files during migration but should not affect execution. New skill guidance should prefer metadata such as:

- `name`
- `description`
- `when-to-use`
- `requires-connectors`
- `requires-binaries`
- `version`

### Connector Binding

Skills may describe how to use connector-provided CLIs and credentials, but skills must not store or manage tokens. Connectors remain the authority for authorization, credential storage, and sandbox injection.

Examples:

- Lark skills teach Codex how to use `lark-cli`.
- Google Workspace skills teach Codex how to use `gog`.
- Notion skills teach Codex how to use `ntn`.
- Bilibili skills teach Codex how to use Bilibili credentials and pipeline scripts.

## Connectors

Connectors stay in Ripple. They own:

- auth start and complete flows
- OAuth callback handling
- account status and live checks
- credential storage and removal
- per-user environment variables and readonly credential mounts
- nsjail configuration regeneration when credentials change

Connector routes are control-plane APIs. They should not depend on Ripple's old tool execution layer.

When Codex detects that a connector is missing, it should explain the missing connector requirement in its answer or approval request. Ripple may later add structured connector-required events, but that is separate from removing the old tool layer.

## Scheduler

Ripple should not keep an embedded scheduler.

Scheduling is better owned by an external system such as the upstream business service, cron, Temporal, n8n, a queue worker, or another deployment-specific orchestrator. Those systems should trigger work by calling `/v1/runs` with the correct `X-Ripple-User-Id`.

This keeps Ripple focused on user-scoped Codex execution and avoids a second background execution model with separate state, retries, approval handling, and command execution semantics.

## System Prompt Changes

The default server prompt should remove instructions about Ripple tools such as Bash, Read, Write, Skill, AskUser, TaskCreate, and AgentRunner.

The new prompt should instead describe:

- Ripple is the control plane.
- Codex is the trusted execution plane.
- The current user and session.
- The current sandbox workspace path.
- Connector status.
- Available skill manifest.
- How to request user approval through Codex when necessary.

## Configuration Changes

Codex remains configured under `external_agents.codex`.

The approval policy may need to change from `never` to a value that allows Codex to emit approval requests. The exact value depends on the Codex app-server protocol and should be confirmed before implementation.

Server-level secrets must not be passed to Codex. User-level credentials should continue to be injected by sandbox connector logic.

## Migration Plan

### Phase 1: Control-Plane Prompt and Skill Manifest

- Replace the current default server prompt with a Codex-only control-plane prompt.
- Add skill manifest generation from shared and workspace skills.
- Include connector status and skill manifest in Codex chat prompts.
- Keep existing code paths in place until tests are updated.

### Phase 2: Codex Approval Bridge

- Probe Codex app-server approval notification and response protocol.
- Add a protocol parser for approval notifications.
- Add pending approval state for sessions and runs.
- Update permission resolution routes to forward Codex approval decisions.

### Phase 3: Remove Ripple Tool Execution From Main Runtime

- Remove model-facing use of Bash, Read, Write, Search, SkillTool, AskUser, Task tools, and AgentRunnerTool.
- Remove old PermissionManager replay logic.
- Remove `/v1/tools/invoke` or turn it into a deprecation response.
- Update tests to assert Codex-only execution.

### Phase 4: Skill and Connector Cleanup

- Move shared skill sandbox mounts to a stable `/opt/ripple/skills/shared/` path.
- Update public skill instructions to remove Ripple Tool references.
- Keep CLI and connector instructions that Codex can execute inside the sandbox.
- Document user skill installation under `/workspace/skills/`.

### Phase 5: Scheduler Removal

- Remove the embedded scheduler runtime and schedule API routes.
- Remove `ScheduleTool`, scheduled command execution, and scheduled agent execution.
- Keep `/v1/runs` as the integration point for external schedulers.
- Remove dependency on `run_sandbox_command` once no retained route needs direct command execution.

## Testing Strategy

Tests should cover:

- Chat completions still start Codex with the current user sandbox.
- `/v1/runs` starts, reads status, steers, and cancels per-user Codex jobs.
- Sessions persist and resume without Ripple tool state.
- Sandbox routes still create, summarize, and delete per-user sandboxes.
- Connector routes still bind, check, and remove per-user credentials.
- Shared skill manifest includes configured shared skills.
- Workspace skill manifest includes `/workspace/skills` skills and shows workspace override.
- Codex approval notifications create pending approval state.
- Approval resolution forwards to Codex instead of replaying a Ripple tool.
- Direct `/v1/tools/invoke` no longer executes tools.
- `/v1/sandbox/schedules*` no longer executes scheduled work.
- External schedulers can trigger work through `/v1/runs` for the desired `user_id`.

## Risks

- Codex app-server approval protocol may not expose explicit approve or reject methods. If so, the first implementation may need to use `turn/steer`.
- Public skills contain many references to old Ripple tools and will need careful text migration.
- UI currently expects some old permission and tool state fields. Server changes should preserve compatible field names where cheap, but UI correctness is not part of this spec.
- Direct command scheduling may be useful for operations tasks. Removing it should be communicated as an intentional move to external scheduling through `/v1/runs`.
- Stable shared skill mount paths require nsjail mount changes and prompt updates at the same time.

## Acceptance Criteria

- Ripple no longer presents its own Bash, Read, Write, Search, Skill, Task, AskUser, or AgentRunner tools to model execution.
- Codex app-server remains the only user-task execution plane.
- Sessions, sandboxes, connectors, runs, and workspace management still work.
- Embedded scheduling is removed or returns a deprecation response that does not execute work.
- Skills are discoverable by Codex through a manifest and readable through stable sandbox paths.
- User workspace skills are supported from `/workspace/skills/`.
- Codex-originated approval requests can be surfaced to the user and resolved through Ripple.
- Old Ripple permission replay logic is removed or bypassed for the main runtime.
