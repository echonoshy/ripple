# External Agent Runner Implementation Plan

This plan was superseded by `docs/superpowers/plans/2026-05-13-codex-app-server-runner.md`.

The accepted implementation uses Codex app-server as the only external runner path:

- Codex is installed once by an administrator on the server.
- Ripple starts one trusted Codex app-server process per `user_id`, lazily.
- Each task starts an independent app-server thread/turn.
- Ripple owns routing, lifecycle, job state, event logs, cancellation, and user isolation.
- The user-visible tool is `AgentRunner`, not `CodingAgent`.
