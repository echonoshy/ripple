# Codex App-Server Worker Pool

本文记录 `ripple-server` 当前 Codex app-server worker pool 形态。旧的“每个 job 启动一个 app-server，job 完成后立即关闭”模型已经被 idle worker pool 取代。

> 说明：`master` 主线默认启用 Codex 原生 memory。Ripple 只注入 Codex thread config，并提供薄状态/重置 API；实际提取、合并和读路径注入由 Codex app-server 完成。

## Boundary

Ripple 是控制面，Codex app-server 是服务端受信执行面宿主进程。

- app-server 不运行在 user nsjail 内。
- Codex shell 命令由 Codex Linux sandbox/bubblewrap 和 Ripple managed permissions profile 约束。
- 不同 user 永不共享 app-server worker、Codex runtime sqlite home、workspace 或 connector credentials。
- 同一 user 的多个 session 和 `/v1/runs` 可以并行执行；worker pool 不能引入 user 级串行锁。

## Pool Key

当前 pool key 由以下维度组成：

```text
user_id + workspace_root + generation
```

不要只用 `user_id` 作为 key。`workspace_root` 能区分未来的多 workspace 或生产 NAS workspace 配置；`generation` 用于在 runtime/config 变化后避免复用旧进程。

## Runtime State

关键代码在 `crates/ripple-server/src/codex/app_server.rs`：

- `PoolState.pools` 保存 `PoolKey -> Vec<PoolWorker>`。
- `PoolWorker` 记录 `worker_id`、`session`、`active_job_id` 和 `last_used_at`。
- `PoolState.job_to_worker` 保存 `job_id -> (PoolKey, worker_id)`。
- `active_turns` 仍按 `job_id` 追踪 active turn，用于 approval、steer 和 cancel。

这意味着 app-server 生命周期由 worker pool 拥有；job 只是在运行期间借用一个 worker。

## Request Lifecycle

Acquire：

1. 根据当前请求计算 `PoolKey`。
2. 优先复用同一 pool 内 `active_job_id == None` 的 idle worker。
3. 没有 idle worker 时，如果未超过配置上限，创建新的 app-server worker。
4. 如果单 pool 或全局 worker 数已达上限，请求等待可用 worker。
5. 记录 `job_id -> worker`，并把该 worker 标记为 active。

Release：

1. 清理当前 job 的 `active_turns` 和 pending approval。
2. 通过 `job_to_worker` 找到 worker。
3. 将 `active_job_id` 置空，更新 `last_used_at`。
4. 不立即 shutdown；等待 idle reaper 按配置关闭。

Shutdown / invalidation：

- `idle_timeout_seconds` 到期。
- `stop_user(user_id)`。
- 用户 sandbox teardown。
- connector disconnect 或 credential 变化。
- Codex executable、app-server args、runtime path、permission profile 等关键配置变化。
- app-server 进程异常退出或 JSON-RPC 请求失败。

## Configuration

配置位于 `external_agents.codex`：

```yaml
external_agents:
  codex:
    idle_timeout_seconds: 1800
    max_workers_per_pool: 50
    max_total_pool_workers: 256
    memory:
      enabled: true
      use_memories: true
      generate_memories: true
      dedicated_tools: false
      disable_on_external_context: false
```

默认值在代码中是：

- `idle_timeout_seconds`: `1800`
- `max_workers_per_pool`: `8`
- `max_total_pool_workers`: `256`
- `memory.enabled`: `true`
- `memory.use_memories`: `true`
- `memory.generate_memories`: `true`
- `memory.dedicated_tools`: `false`
- `memory.disable_on_external_context`: `false`

生产环境可以按机器容量调大 `max_workers_per_pool`，但仍建议保留全局上限，避免单机进程数失控。

## Concurrency Rules

- 同一 session 的 chat/compaction 仍由 session 级互斥保护，避免同一对话上下文乱序。
- 同一 user 的不同 session 或 `/v1/runs` 可以并行借用不同 worker。
- approval、steer、cancel 必须只作用于目标 `job_id`，不能按 user 或 pool 广播。
- connector credential 变化后必须关闭对应用户的 pooled workers，避免旧环境继续执行。

## Memory Behavior

Ripple 会在 Codex `thread/start` / `thread/resume` config 中注入：

- `features.memories`
- `memories.use_memories`
- `memories.generate_memories`
- `memories.dedicated_tools`
- `memories.disable_on_external_context`

默认对用户 chat/session 开启 read/write。内部标题生成、task trigger extraction 和标记为 temporary 的 chat turn 会显式禁用 memory，避免后台工具轮污染用户记忆。

后端提供三个用户级 memory API：

- `GET /v1/memory/status`
- `GET /v1/memory/summary`
- `POST /v1/memory/reset`

还提供 `POST /v1/sessions/{session_id}/memory/disable`，用于把某个 session 及其 Codex thread 置为 memory disabled。若该 session 已有 Codex thread，Ripple 先调用 Codex app-server 的 `thread/memoryMode/set` 成功后，再持久化本地 `memory_disabled`。

## Observability

日志和 diagnostics 中可以记录：

- pool hit / miss
- app-server start / stop reason
- pool key
- worker id
- per-pool worker count
- total worker count
- idle timeout duration
- app-server stderr tail

不要在用户可见 API 中暴露敏感路径、token、auth file 或 connector credential。

## Verification

后端改动至少覆盖：

- 同一 user、同一 workspace 连续两个 job 复用 idle worker。
- job 完成后不会立即 shutdown。
- idle timeout 到期后 shutdown。
- `stop_user(user_id)` 关闭该用户所有 pooled workers。
- 不同 user 不共享 worker。
- 不同 workspace/generation 不共享 worker。
- worker 上限配置生效。
- approval、steer、cancel 仍只作用于目标 job。

建议命令：

```bash
cargo test -p ripple-server codex::app_server
cargo check -p ripple-server
```
