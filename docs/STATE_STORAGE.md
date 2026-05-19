# File State Storage

Ripple currently uses local files as the control-plane state store. This is
intentional for the fast-iteration phase: there is no SQLite, Redis, queue, or
external metadata service in the default runtime.

## Source Of Truth

- `.ripple/sandboxes/<user_id>/user.json`
  User profile and quota metadata.
- `.ripple/sandboxes/<user_id>/sessions/<session_id>/meta.json`
  Session status, model settings, pending approval/question state, and usage.
- `.ripple/sandboxes/<user_id>/sessions/<session_id>/messages.jsonl`
  User-visible conversation history.
- `.ripple/sandboxes/<user_id>/sessions/<session_id>/model_messages.jsonl`
  Codex-facing message history. This is runtime state and can be rebuilt more
  easily than `messages.jsonl`.
- `.ripple/sandboxes/<user_id>/agent-runs/external-agents/<job_id>/meta.json`
  Agent run summary.
- `.ripple/sandboxes/<user_id>/agent-runs/external-agents/<job_id>/events.jsonl`
  Agent run timeline. Events carry a per-file `sequence`.
- `.ripple/sandboxes/<user_id>/agent-runs/external-agents/<job_id>/output.txt`
  Agent output artifact.
- `.ripple/sandboxes/<user_id>/documents/index.json`
  Lightweight metadata index for files that live in the workspace.
- `.ripple/sandboxes/<user_id>/workspace/`
  User files and Codex execution workspace.
- `.ripple/sandboxes/<user_id>/credentials/`
  Per-user connector credentials and local keyring material.

## Write Rules

- JSON state files should be written through `ripple.utils.file_state` atomic
  helpers.
- JSONL files are append-only timelines. Corrupt lines are skipped by readers,
  and new run events receive monotonically increasing per-file `sequence`
  values.
- State files should include a `version` field when the format is owned by
  Ripple and not a compatibility surface for tools.

## Restart Reconciliation

On server startup, Ripple marks stale file-backed runtime state as failed when
it was active before process memory was lost:

- running or queued agent runs become `failed`
- active session states become `failed`
- pending questions and approval requests are cleared

This keeps the UI from showing work as indefinitely running after a restart.

## Deployment Assumptions

This file backend assumes a single Ripple server process writes a given
`.ripple/` directory. Do not run multiple uvicorn workers or multiple server
instances against the same state directory unless a stronger storage backend is
introduced.
