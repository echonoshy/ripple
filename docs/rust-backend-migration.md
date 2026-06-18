# Rust Backend Current State

Ripple 的 Rust 后端已经是当前控制面主链路。本文保留“迁移”文件名，方便旧链接继续有效；内容按当前实现维护，不再记录 Python/FastAPI 迁移计划。

## Current Shape

- `ripple-server` 是独立 Linux 后端服务，Web、Tauri 和 Mobile 都只是 `/v1` API 客户端。
- 后端保持多用户模型。默认可信上游通过 `X-Ripple-User-Id` 注入隔离身份；启用 `server.user_auth.enabled` 后，浏览器用户也可以通过邀请制账号登录，后端使用 session token 绑定的 `user_id`。
- sandbox 以 `user_id` 为单位，一个 user 拥有长期 workspace，多个 session 和 `/v1/runs` 共享该 workspace。
- 控制面状态使用 SQLite：session、messages、jobs、schedules、documents、auth user/session/invite 和索引 metadata 存在 `.ripple/ripple.sqlite`。
- Codex app-server 是执行面。Rust 后端维护按 `user_id + workspace_root + generation` 隔离的 app-server worker pool，job 运行时借用 worker，完成后释放为 idle worker。
- Skills 继续使用 Markdown/YAML frontmatter；Python 只允许作为 `skills` 下的 helper。

Python/FastAPI 后端和 legacy Python `ripple` 控制面已经移除，不再作为参考实现或新增能力入口。

## Implemented Surface

Rust 后端位于：

```text
crates/ripple-server/
```

当前 Rust 控制面已经覆盖主链路：

- 配置加载、服务级 API key middleware、轻量 user auth、`X-Ripple-User-Id` 校验。
- user sandbox、workspace root 分离配置、session metadata/messages、workspace 文件 API、documents、user profile/quota。
- Notion、Google Workspace、Feishu/Lark、Bilibili connector 授权、状态、账号列表和断开。
- Codex app-server JSON-RPC provider、worker pool、session 级 chat/compaction 互斥、`/v1/runs`、`/v1/chat/completions`。
- OpenAI-compatible 非流式和 SSE 响应、Codex event 映射、token usage 持久化、workspace attachment 和 image 事件导入。
- Codex approval bridge、session stop/delete/context clear/suspend/resume、sandbox teardown cancellation。
- Schedule CRUD、run history、run-now、due schedule trigger、chat-side schedule proposal/confirmation。
- Tasks / TaskActions CRUD、session task listing、task event/progress、run-now、due task action trigger、schedule-task link，以及 chat-side `codex_app.task_update` 动态工具。
- Codex managed permissions profile、服务端 Codex auth deny-read、skill manifest rendering。
- OpenAPI/Swagger 文档入口、doctor/ready diagnostics、backup posture 检查。
- Rust route smoke coverage 覆盖主要 `/v1` API、fake Codex app-server、fake nsjail connector CLI 边界和 server listener 启动。

## Remaining Hardening

优先级如下：

1. `/v1/chat/completions`
   - 用真实 Codex streaming 事件补充端到端 fixtures。
   - 覆盖真实上传 image/file attachment 的 follow-up turns。

2. Chat-side schedule creation
   - 用真实 Codex extraction 输出验证 schedule proposal/confirmation。
   - 覆盖老客户端 UI flow。

3. Session/job/task lifecycle
   - 用真实 Codex `codex_app.task_update` 输出补充 task proposal、progress、run-now 和 source-session writeback fixtures。
   - 为自动 idle suspend 和 suspended retention cleanup 增加 controlled-time route tests。
   - 增加 active/queued job 下 steering、approval、cancel，以及 due task action trigger 的压力测试。

4. Connector runtime boundary
   - 在真实 nsjail runtime 下验证 Google Workspace、Feishu/Lark 等 CLI auth/status flow。
   - 保持 connector 状态检查和 app-server 执行使用同一 Codex home/env 语义。

## Verification

Rust 后端最小验证：

```bash
cargo fmt -p ripple-server
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
