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
- Session metadata and message store under `sessions/<session_id>/`, including list/get/create/delete/context-clear and pending approval state.
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
- Chat-side connector auth interception and polling for Notion, Google Workspace, Feishu/Lark, and Bilibili, including SSE auth events and automatic resume after completion.
- Codex approval bridge from app-server notifications to session pending approval and `/sessions/{session_id}/permissions/resolve`.
- Schedule CRUD, schedule run history, run-now, and a background due-schedule trigger loop.
- Codex managed permissions profile injection for the user workspace and deny-read rules around service Codex auth paths.
- Codex process env for uv/node caches, package mirrors, Notion token, and gog keyring password.
- Skill manifest rendering from shared and workspace skills.
- Shared skills moved to `src/skills/*`; tracked sample config and Rust defaults now point at the new location.
- Skill docs with executable helper scripts now use paths relative to their own skill directory, avoiding stale local absolute paths.

Not implemented yet:

- Full Python FastAPI parity for specialized chat-side schedule creation prompts.
- Richer chat SSE parity for Codex runtime/tool/image/usage events.
- Session stop/suspend/resume parity beyond the current compatibility responses.
- Full nsjail short-command mount/env parity for internal control-plane commands.
- Deprecated compatibility APIs such as `/v1/tasks` if older clients still require them.

## Verification

```bash
cargo check -p ripple-server
cargo test -p ripple-server
```

Python FastAPI remains the production backend until the Rust Codex runner and connector auth flows reach parity.
