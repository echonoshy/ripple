# Codex App Server Integration Notes

## Persistent Thread Decision

Ripple should keep Codex app-server threads ephemeral for now.

Current setting:

```yaml
external_agents:
  codex:
    ephemeral_threads: true
```

Reason:

- Ripple already owns the durable user-facing session: messages, task state, approvals, sandbox, and job history.
- The current server Codex authorization is shared service state, while future plugin/MCP state will need per-user isolation. Reusing persisted Codex threads before that split is finished risks mixing execution state across users.
- Ripple's prompt builder already injects recent conversation history into each turn, so the immediate functional benefit of persistent Codex threads is smaller than the isolation risk.

## Future Mapping

If persistent Codex threads are enabled later, the mapping should be:

```text
(user_id, ripple_session_id) -> codex_thread_id
```

Storage:

- Store `codex_thread_id` in the Ripple session metadata under the same per-user session directory that already stores `meta.json`.
- Never store a thread id globally without `user_id`.
- Never accept a thread id directly from an untrusted client as the source of truth.

Lifecycle:

1. On the first run for a Ripple session, call `thread/start` with `ephemeral: false`.
2. Persist the returned `thread.id` only after the thread is successfully created.
3. On later runs for the same Ripple session, reuse that thread id instead of starting a new thread.
4. If Codex reports the thread is missing or invalid, clear only that session's stored `codex_thread_id` and create a replacement thread.
5. When deleting a Ripple session, clear its stored thread id. If Codex exposes a reliable thread delete API, call it best-effort.

## Isolation Rules

Persistent thread reuse must follow these rules:

- The lookup key must include `user_id`; two users can never share a Codex thread id.
- The restored thread must belong to the same Ripple session and the same workspace root.
- Codex app-server process pooling can remain per user, but persisted Codex user state must not be the shared service `CODEX_HOME` if plugins or MCP credentials become user-installable.
- Server OpenAI/Codex login state remains deployment-owned. User plugin/MCP credentials must live in per-user state and must not be copied into the workspace.
- The shell environment must continue excluding service `CODEX_HOME`, and managed permissions must continue denying reads of the service Codex home and host `~/.codex`.

## API Shape

No public API should expose raw thread ids by default. If debugging requires visibility, expose them as read-only metadata behind an admin/debug endpoint, not as a client-selectable execution parameter.
