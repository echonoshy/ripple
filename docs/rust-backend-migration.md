# Rust Backend Migration

Ripple 的 Rust 迁移目标是重写后端控制面，而不是把后端嵌进 Tauri 客户端。

## Target Shape

- `ripple-server` 是独立 Linux 后端服务。
- Web、Tauri 和 Mobile 都只是客户端，只调用 Ripple Server 的 `/v1` API。
- 后端继续保持多用户模型，`X-Ripple-User-Id` 是可信上游传入的 user 隔离入口；Ripple 不做终端用户鉴权和用户权限管理。
- sandbox 以 `user_id` 为单位，一个 user 拥有长期 workspace，多个 session 共享该 workspace。
- Codex app-server 是执行面。Rust 后端负责启动、隔离、转发 JSON-RPC、收集事件、持久化状态。
- Skills 继续使用 Markdown/YAML frontmatter；Python 仅允许作为 `skills` 下的 helper。

## Current State

Rust 后端位于：

```text
crates/ripple-server/
```

当前 Rust 控制面已经覆盖主链路：

- 配置加载、服务级 API key middleware、`X-Ripple-User-Id` 校验。
- user sandbox、session metadata/messages、workspace 文件 API、documents、最小 user profile。
- Notion、Google Workspace、Feishu/Lark、Bilibili connector 授权、状态和断开。
- Codex app-server JSON-RPC provider、per-user 执行锁、`/v1/runs`、`/v1/chat/completions`。
- OpenAI-compatible 非流式和 SSE 响应、Codex event 映射、token usage 持久化、workspace attachment 和 image 事件导入。
- Codex approval bridge、session stop/delete/context clear/suspend/resume、sandbox teardown cancellation。
- Schedule CRUD、run history、run-now、due schedule trigger、chat-side schedule proposal/confirmation。
- Codex managed permissions profile、服务端 Codex auth deny-read、skill manifest rendering。
- Rust route smoke coverage覆盖主要 `/v1` API、fake Codex app-server、fake nsjail connector CLI 边界和 server listener 启动。

Python/FastAPI 后端和 legacy Python `ripple` 控制面已经移除，不再作为参考实现或新增能力入口。Python 仅保留在 skill helper 中。

## Remaining Hardening

优先级如下：

1. `/v1/chat/completions`
   - 用真实 Codex streaming 事件补充端到端 fixtures。
   - 覆盖真实上传 image/file attachment 的 follow-up turns。

2. Chat-side schedule creation
   - 用真实 Codex extraction 输出验证 schedule proposal/confirmation。
   - 覆盖老客户端 UI flow。

3. Session/job lifecycle
   - 为自动 idle suspend 和 suspended retention cleanup 增加 controlled-time route tests。
   - 增加 active/queued job 下 steering、approval、cancel 的压力测试。

4. Connector runtime boundary
   - 在真实 nsjail runtime 下验证 Google Workspace、Feishu/Lark 等 CLI auth/status flow。
   - 保持 connector 状态检查和 app-server 执行使用同一 Codex home/env 语义。

5. Deprecated compatibility
   - `/v1/tasks` 目前保留为 410 compatibility response。
   - 确认老客户端不再访问后，可以删除该 compatibility route 和测试。

## Verification

Rust 后端最小验证：

```bash
cargo check -p ripple-server
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
```

前端相关改动另跑：

```bash
cd app
bun run lint
bun run build
```
