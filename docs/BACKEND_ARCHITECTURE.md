# Ripple Backend Architecture

本文记录 `ripple-server` 当前后端架构。它不是迁移计划；Python/FastAPI 后端和 legacy Python `ripple` 控制面已经移除，不再作为参考实现或新增能力入口。

## Current Shape

- `ripple-server` 是独立 Linux 后端服务，Web、Tauri、Mobile 都只是 `/v1` API 客户端。
- 后端保持多用户模型。生产由可信上游注入 `X-Ripple-User-Id`，并用服务级 API key 调用 Ripple。
- `server.user_auth` 只用于开发/内测阶段的轻量邀请登录，不是生产部署主线。
- sandbox 以 `user_id` 为单位，一个 user 拥有长期 workspace，多个 session 和 `/v1/runs` 共享该 workspace。session 可以再绑定更小的 `context_folder_path` 作为本次 Codex 项目根和默认权限根。
- SQLite 是控制面状态存储；workspace 文件、附件二进制、Codex runtime、connector credentials 仍保存在文件系统。
- Codex app-server 是执行面。Rust 后端维护按 `user_id + workspace_root + generation` 隔离的 app-server worker pool，job 运行时借用 worker，完成后释放为 idle worker。
- Skills 继续使用 Markdown/YAML frontmatter；Python 只允许作为 `skills` 下的 helper。

生产部署步骤见 [BUILD_AND_DEPLOY.md](BUILD_AND_DEPLOY.md)。

## Implemented Surface

Rust 后端位于：

```text
crates/ripple-server/
```

当前控制面覆盖：

- 配置加载、服务级 API key middleware、轻量 user auth、`X-Ripple-User-Id` 校验。
- user sandbox、workspace root 分离配置、session metadata/messages、workspace 文件 API、documents、user profile/quota。
- Notion、Google Workspace、Feishu/Lark、Bilibili connector 授权、状态、账号列表和断开。
- Codex app-server JSON-RPC provider、worker pool、session 级 chat/compaction 互斥、目录级 permission root、`/v1/runs`、`/v1/responses`。
- Responses-style subset `/v1/responses` 非流式和 SSE 响应、Codex event 映射、token usage 持久化、workspace attachment 和 image 事件导入。
- 模型厂商兼容不在 Ripple 内实现 OpenAI-compatible proxy 或厂商 adapter；该边界由 Codex app-server 的 `model_provider` / Responses API 支持负责。
- Codex approval bridge、session stop/delete/context clear/suspend/resume、sandbox teardown cancellation。
- Task Sessions 产品层 API，覆盖任务会话列表/详情、TaskSpec、TaskRun、确认卡和会话事件流。
- 内部 Tasks / TaskActions 状态、task event/progress、due time trigger loop，以及 chat-side `codex_app.task_update` 动态工具；旧 `/v1/tasks` / Task Trigger HTTP API 不再公开注册，`/v1/sessions/:session_id/tasks` 只作为 session 兼容读接口保留。
- Chat-side task-trigger proposal/confirmation 只创建 Task + Task Trigger；旧 standalone schedule API 和 `/v1/schedules` 已移除。
- Codex managed permissions profile、目录级 `request_permissions` approval bridge、服务端 Codex auth deny-read、skill manifest rendering、runtime capability catalog。
- OpenAPI/Swagger 文档入口、doctor/ready diagnostics、Codex app-server protocol/permission profile diagnostics、backup posture 检查。

## Storage Boundary

进入 SQLite：

- users、auth invites、auth sessions
- sessions
- session messages
- runs/jobs metadata
- task triggers
- task sessions、task specs、task runs、task confirmations、task session events
- tasks、task actions、task events（内部执行层；旧 `/v1/tasks` HTTP API 不再公开注册）
- documents index
- pending approval / pending question / pending connector auth 状态
- plan steps / progress
- 文件索引 metadata：路径、大小、mime、hash、关联 session/document

不进入 SQLite：

- workspace 文件内容
- 用户上传文件内容
- 图片、PDF、附件二进制
- Codex runtime 目录文件
- connector credential 文件
- run events.jsonl
- run output.txt

运行时模型：

- 默认数据库位置是 `.ripple/ripple.sqlite`；生产通常通过 `.ripple -> /nas/ripple-data/ripple-runtime` symlink 放到持久目录。
- SQLite 使用 WAL，运行时会同时出现 `ripple.sqlite-wal` 和 `ripple.sqlite-shm`。
- 表内统一带 `user_id`，查询和写入都必须保持 user scope。
- `Storage::open` 初始化表结构、补齐必要 schema column，并记录 `schema_migrations`。
- session message append、session meta update、run status 更新、task trigger/action update 这类状态变化应保持短事务。
- `/v1` response shape 不因 SQLite 存储改变而破坏旧客户端。

旧文件状态不会在服务启动时自动迁移。需要时显式运行一次：

```bash
ripple-server migrate-files-to-sqlite --config config/settings.yaml
```

## Runtime Boundaries

Ripple 是控制面，Codex app-server 是服务端受信执行面宿主进程。

- Codex app-server 不运行在 user `nsjail` 内。
- Codex shell 命令由 Codex Linux sandbox / `bubblewrap` 和 Ripple managed permissions profile 约束。
- Connector CLI auth/status flow 通过 `nsjail` 运行时和 per-user credentials 执行。
- Codex sandbox prerequisites 或 connector `nsjail` runtime probe 失败时按 fail-closed 处理，不静默降级执行。
- 不同 user 永不共享 app-server worker、Codex runtime sqlite home、workspace 或 connector credentials。
- 同一 user 的多个 session 和 `/v1/runs` 可以并行执行；worker pool 不能引入 user 级串行锁。

不要把服务端 Codex auth 暴露给 user workspace，也不要把 `auth.json` 写入 `/nas/ripple-data/sandboxes/<user_id>/workspace/`。

### Workspace 与 Permission Root

- user workspace 是长期文件存储边界，例如 `/workspace` 映射到 `.ripple/sandboxes/<user_id>/workspace` 或配置的外部 workspace root。
- session 的 `context_folder_path` 是当前 Codex 项目根和默认权限根。`null` 表示 `/workspace`；space/record 对话应传入对应 `/workspace/...` 目录。
- 创建或更新 session 时，`context_folder_path` 必须是当前 user workspace 内已存在的目录。active run、pending approval、pending user input 或 compaction 期间不允许切换 context folder。路径实际变化时，Ripple 保留 session 消息，但解除原 `codex_thread_id` 并让下一轮创建新的 Codex thread，避免旧 thread 的 cwd 与 sandbox permission root 分裂。
- chat、run 和 compaction 启动 Codex 时使用该目录作为 cwd，并把同一路径作为 permission root 生成 Codex managed permissions profile。
- scoped session 下，workspace 根默认 `none`；permission root 为 `write`；同一 workspace 下的同级或其他目录读写必须由 Codex `request_permissions` 发起审批。
- scoped context folder 可以同时包含真实记录子目录和指向当前 user workspace 内非敏感记录目录的直属软链接。只要存在合法成员软链接，该集合目录本身只读；Ripple 会把真实记录子目录和验证后的 canonical link target 都作为可读写 record roots，避免混合 Space 隐藏真实子目录。越出 workspace、指向敏感目录、循环或非目录链接按 fail-closed 忽略。
- chat folder context 检索与 Codex permission profile 共用同一套受控成员解析规则：扫描集合内真实记录子目录及已授权的直属链接目标，不递归跟随记录内的二级软链接。
- `/workspace/.tmp` 作为运行时 scratch 例外保留 `write`。提示词要求临时分析和转换产物优先写 `$TMPDIR`。
- 从 `/workspace` 到 permission root 路径上的 `AGENTS.md` 会被精确授予 `read`，用于加载目录规则；`AGENTS.md` 只提供上下文约定，不是安全边界。
- shared skills、connector CLI/runtime/cache 继续按最小必要读写开放；服务端 Codex auth、其他 user sandbox、`.agents/skills` 和 `.codex/skills` 继续 deny，避免绕过 Ripple skill manifest。

## Worker Pool

当前 pool key：

```text
user_id + workspace_root + generation
```

不要只用 `user_id` 作为 key。`workspace_root` 能区分多 workspace 或生产 NAS workspace 配置；`generation` 用于在 runtime/config 变化后避免复用旧进程。

请求生命周期：

1. 根据当前请求计算 `PoolKey`。
2. 优先复用同一 pool 内 `active_job_id == None` 的 idle worker。
3. 没有 idle worker 时，如果未超过配置上限，创建新的 app-server worker。
4. 如果单 pool 或全局 worker 数已达上限，请求等待可用 worker。
5. job 完成后释放 worker 为 idle，不立即 shutdown。
6. idle timeout、`stop_user(user_id)`、sandbox teardown、connector credential 变化、关键配置变化或 worker 异常退出时关闭相关 worker。

配置：

```yaml
external_agents:
  codex:
    idle_timeout_seconds: 1800
    max_workers_per_pool: 50
    max_total_pool_workers: 256
```

并发规则：

- 同一 session 的 chat/compaction 仍由 session 级互斥保护。
- 同一 user 的不同 session 或 `/v1/runs` 可以并行借用不同 worker。
- approval、steer、cancel 必须只作用于目标 `job_id`，不能按 user 或 pool 广播。
- connector credential 变化后必须关闭对应用户的 pooled workers，避免旧环境继续执行。

## Verification

Rust 后端最小验证：

```bash
cargo fmt -p ripple-server
cargo check -p ripple-server
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
```

触碰 worker pool 时至少覆盖：

- 同一 user、同一 workspace 连续两个 job 复用 idle worker。
- job 完成后不会立即 shutdown。
- idle timeout 到期后 shutdown。
- `stop_user(user_id)` 关闭该用户所有 pooled workers。
- 不同 user 不共享 worker。
- 不同 workspace/generation 不共享 worker。
- worker 上限配置生效。
- approval、steer、cancel 仍只作用于目标 job。
