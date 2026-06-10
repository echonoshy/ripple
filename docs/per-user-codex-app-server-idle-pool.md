# Per-User Codex App-Server Idle Pool

本文记录 Ripple 将 Codex app-server 从“按 job 启动、job 结束后关闭”演进为“按用户复用、空闲后关闭”的设计思路。

## 背景

Ripple 是控制面，Codex app-server 是执行面。当前主链路里，每个 Codex job 会启动一个可信 app-server 进程，完成后关闭。

这个模型隔离清晰，但对 Codex 原生 memory 不够友好。Codex memory pipeline 是 app-server 在处理 turn 时启动的后台任务，它会扫描旧 thread、抽取 raw memory，并进一步整理为 `MEMORY.md` 和 `memory_summary.md`。如果 job 很短，Ripple 关闭 app-server 时，后台 memory task 可能还没跑完。

因此可以考虑引入 per-user app-server idle pool：让同一用户的 app-server 在 job 结束后保留一段时间，给 memory pipeline 和后续同用户请求复用。

## 目标

- 让同一 `user_id` 的 Codex app-server 可以在多个 job 之间短期复用。
- 保持 Ripple 的多用户隔离模型：不同用户不能共享 app-server、Codex home、workspace、connector credentials 或 memory。
- 保留当前同一用户多 session / 多 run 可并行执行的能力。
- 提高 Codex memory pipeline 完成概率，减少因 job 结束过快导致的后台任务中断。
- 让进程生命周期可观测、可清理、可重启。

## 非目标

- 不做全局单例 Codex app-server。
- 不把同一用户的所有任务强行串行化。
- 不把 memory 存储从 Codex 原生 memory 改成 Ripple 自定义 memory 系统。
- 不把服务端业务逻辑下沉到前端或 Tauri 客户端。

## 当前实现状态

当前关键代码在 `crates/ripple-server/src/codex/app_server.rs`：

- `CodexAppServerProvider` 已改为 per-user/workspace/generation worker pool。
- `session_for_request()` 会先复用同一 pool 内的 idle worker；如果所有 worker 都 busy，会创建新 worker，直到内部 worker 上限。
- job 完成后 `release_job_session(job_id)` 只把 worker 标记为 idle，不立即关闭 app-server 进程。
- idle reaper 根据 `external_agents.codex.idle_timeout_seconds` 关闭过期 idle worker。
- `active_turns` 仍然按 `job_id` 追踪 active turn，用于 approval、steer 和 cancel。
- `stop_user(user_id)`、memory reset、Notion / Google Workspace / Bilibili credential 变化会关闭对应用户的 pooled app-server，避免复用旧 runtime/env。

这意味着 app-server 生命周期已经从 job 拥有演进为 worker pool 拥有；job 只是在运行期间借用 worker。

## 推荐形态

将生命周期改成：

```text
user_id + workspace_root + runtime_generation -> pooled app-server
```

也就是 app-server 由用户级 pool 管理，job 只是借用。

不要只用 `user_id` 作为 pool key。建议把 `workspace_root` 和 runtime/config generation 一起纳入 key，避免未来出现同一用户多 workspace、配置热更新、权限 profile 变化时误复用旧进程。

```text
PoolKey {
  user_id,
  workspace_root,
  generation
}
```

`generation` 可以先由进程启动时的关键配置 hash 或简单递增版本表示，例如 Codex executable、app-server args、sandbox runtime path、managed permission profile 相关配置发生变化时提升 generation。

## 数据结构

建议新增：

```text
PoolEntry {
  session: Arc<CodexAppServerSession>,
  user_id: String,
  workspace_root: PathBuf,
  active_count: usize,
  last_used_at: Instant,
  idle_deadline: Option<Instant>,
  generation: String,
}
```

`CodexAppServerProvider` 可以演进为：

```text
CodexAppServerProvider {
  pools: Mutex<HashMap<PoolKey, PoolEntry>>,
  job_to_pool: Mutex<HashMap<String, PoolKey>>,
  active_turns: Mutex<HashMap<String, ActiveTurn>>,
  pending_approvals: Mutex<HashMap<String, Value>>,
}
```

`active_turns` 继续按 job 保存，不应改成 user 级。approval、steer、cancel 都是 job/turn 级操作。

## 请求生命周期

### Acquire

每个 job 启动前：

1. 从 request 中解析 `user_id`、`workspace_root`、generation。
2. 构造 `PoolKey`。
3. 查找 pool。
4. 如果已有进程且仍然存活：
   - 取消 idle shutdown。
   - `active_count += 1`。
   - 记录 `job_id -> PoolKey`。
   - 返回 session。
5. 如果没有可用进程：
   - 创建新的 `CodexAppServerSession`。
   - `ensure_started()`。
   - `ensure_initialized()`。
   - 插入 pool。
   - `active_count = 1`。
   - 记录 `job_id -> PoolKey`。

### Run

job 运行期间仍按当前模式：

- `ensure_thread()` 创建或恢复 Codex thread。
- `turn/start` 启动 turn。
- `active_turns[job_id]` 记录 `{ session, thread_id, turn_id }`。
- 事件、输出、approval、cancel 仍按 job 维度处理。

### Release

job 结束后：

1. 清理 `active_turns[job_id]`。
2. 清理 `pending_approvals[job_id]`。
3. 通过 `job_to_pool[job_id]` 找到 pool entry。
4. `active_count -= 1`。
5. 更新 `last_used_at`。
6. 如果 `active_count == 0`，设置 idle deadline，例如 10 到 30 分钟。
7. 不立即 shutdown。

后台 idle reaper 到期后再次检查：

- entry 仍存在。
- `active_count == 0`。
- `last_used_at` 没有被更新。
- generation 没有变化。

满足条件才关闭进程并移除 entry。

## 并发模型

Ripple 当前明确允许同一 user 的多个 session 和 `/v1/runs` 并行执行，共享 workspace。per-user app-server idle pool 不能破坏这个语义。

因此不能简单加 user 级锁，把同一用户所有任务串行化。

需要先验证 Codex app-server 单进程是否稳定支持同一用户多个 thread/turn 并发。如果支持：

```text
user_id -> one pooled app-server
```

如果不支持或压力测试不稳定，应升级为：

```text
user_id -> small worker pool
```

例如每个用户最多 2 到 4 个 app-server worker。调度策略：

- 优先复用空闲 worker。
- 没有空闲 worker 且未达到上限时创建新 worker。
- 达到上限时只对该用户的新增 job 排队，不能影响其他用户。

这样既保持同用户并发能力，又避免每个 job 都冷启动。

## 多端接入

同一个用户的 Web、桌面、移动端会共享同一个 `user_id`，因此也应该共享同一组 per-user app-server pool。

影响点：

- 多端同时发起不同 session 的任务时，pool 需要支持并发或 worker pool。
- 同一个 session 的连续 chat 仍需要 session 级互斥，避免上下文顺序错乱。
- memory settings 必须在每次 job 启动前由 Ripple 重新读取，不能长期缓存到 pool entry 中。
- connector credential 变化、memory reset、用户 logout/stop 等操作需要能重启或清理该用户的 pool entry。

## Memory 行为

Settings 里的 memory 开关只保存用户偏好，不直接触发抽取。

每次 chat/run 启动时，Ripple 会读取当前用户的 memory settings，并把下面配置注入 Codex thread config：

```text
features.memories
memories.use_memories
memories.generate_memories
memories.dedicated_tools = false
memories.disable_on_external_context = false
```

真正的 memory 抽取由 Codex app-server 内部触发。app-server 收到有用户输入的 turn 后，会启动 memory startup task。该任务会扫描符合条件的旧 thread，而不是立刻抽取当前 turn。

`disable_on_external_context` 设为 `false` 是有意为之：Ripple 的真实任务经常会经过 web/search/connector，上游 Codex 会在 `true` 时把这些 thread 标成 `polluted`，导致最有价值的任务无法进入 memory 候选。Ripple 侧通过把控制面 prompt 放入 `baseInstructions` / `additionalContext`，避免把控制面文本伪装成用户输入。

引入 idle pool 后，job 完成不会立刻关闭 app-server，因此 Codex 内部 memory pipeline 有更大概率跑完。

但 Ripple 仍建议增加一个 per-user memory maintenance guard：

```text
memory_maintenance_running[user_id]
```

即使 Codex 内部已有 DB claim 和 phase-2 lock，Ripple 侧也应避免同一用户因为多端/多 session 高频 turn 而反复触发过多 memory startup task。

## 清理和重启条件

以下情况应关闭或重启对应用户的 pool entry：

- idle timeout 到期。
- `stop_user(user_id)`。
- 用户 sandbox teardown。
- memory reset。
- connector disconnect 或 credential 变化。
- Codex executable、app-server args、runtime path、permission profile 等关键配置变化。
- app-server 进程异常退出。
- 连续 JSON-RPC 请求失败，达到健康检查阈值。

关闭时必须：

- 移除 pool entry。
- 移除相关 `job_to_pool` 映射。
- 清理该 session 关联的 pending approvals。
- 对 active turn 做 interrupt 或标记 job cancelled/failed，避免前端一直等待。

## 可观测性

建议增加日志和诊断字段：

- pool hit / miss。
- app-server start / stop reason。
- active_count。
- idle timeout duration。
- per-user pool size。
- worker id。
- memory startup task 触发次数和最近完成时间，如果 Codex 能暴露。
- app-server stderr tail 仍需按现有 redaction 处理。

可以在 diagnostics 或 internal logs 中暴露：

```text
user_id
pool_key
worker_id
active_count
last_used_at
started_at
stop_reason
```

不要在用户可见 API 中暴露敏感路径、token、auth file 或 connector credential。

## 配置建议

当前实现先复用既有配置：

```yaml
external_agents:
  codex:
    idle_timeout_seconds: 1800
```

worker 上限暂为服务端内部常量：单个 pool 最多 4 个 worker，全局最多 64 个 worker。

新增配置可以放在 `config/*.yaml`：

```yaml
codex:
  app_server_idle_pool:
    enabled: true
    idle_timeout_seconds: 900
    max_workers_per_user: 2
    max_total_workers: 64
    healthcheck_timeout_seconds: 5
```

默认可以先关闭，灰度开启：

```yaml
enabled: false
```

上线时先对测试用户或内部环境启用。

## 测试计划

后端单元测试：

- 同一 user、同一 workspace 连续两个 job 复用同一个 app-server。
- job 完成后不会立即 shutdown。
- idle timeout 到期后会 shutdown。
- 新 job 在 idle timeout 前到来会取消 shutdown。
- `stop_user(user_id)` 会关闭该用户所有 pooled app-server。
- 不同 user 不共享 app-server。
- 不同 workspace/generation 不共享 app-server。

并发测试：

- 同一 user 两个不同 session 同时 run，不串事件、不串 output。
- approval、steer、cancel 仍然只作用于目标 job。
- 同一 session 互斥仍然生效。

memory 相关测试：

- memory settings 改变后，下一次 job 注入最新配置。
- memory reset 后对应用户 pool 重启或清理。
- temporary/internal jobs 不使用或生成 memory。
- connector/external context 不应把正常任务标成 `polluted`。
- Ripple 控制面 prompt 不应出现在 Codex thread 的 user input/title/preview 中。

故障测试：

- app-server 进程退出后 pool 自动移除，下次请求重启。
- JSON-RPC pending request 失败后 job 能正确失败。
- idle reaper 不会关闭 active_count 大于 0 的 entry。

## 分阶段落地

### Phase 1: Pool Skeleton

- 引入 `PoolKey`、`PoolEntry`、`job_to_pool`。
- 将 `session_for_request()` 改成 acquire pool entry。
- 将 `shutdown_job_session(job_id)` 改成 release pool entry。
- 保持默认配置关闭。

### Phase 2: Idle Reaper

- 增加 idle timeout。
- 增加 `stop_user(user_id)` 清理 pool。
- 增加基础日志和测试。

### Phase 3: Concurrency Validation

- 对同一 user 多 session 并发运行做压力测试。
- 如果单 app-server 并发稳定，保留 one worker per user。
- 如果不稳定，引入 per-user worker pool。

### Phase 4: Memory Hardening

- 增加 memory maintenance guard。
- memory reset / connector credential 变化时重启对应 pool。
- 记录 memory 相关诊断信息。

### Phase 5: Gradual Enablement

- 内部用户灰度。
- 小比例生产用户启用。
- 观察进程数、内存、job 延迟、memory summary 更新时间、失败率。
- 再决定是否默认开启。

## 风险和缓解

| 风险 | 缓解 |
| --- | --- |
| 跨用户状态串扰 | pool key 必须包含 user_id；不同 user 永不共享进程 |
| 同用户并发不稳定 | 先压测单 worker；不稳定则改 per-user worker pool |
| 权限 profile 残留 | 每次 turn 创建/恢复 thread 时重新注入 thread config |
| memory settings 过期 | 每次 job 启动前重新读取 settings，不缓存到 pool |
| connector 凭证变化后进程持有旧环境 | credential 变化时重启该用户 pool |
| 进程泄漏 | idle reaper、max workers、stop_user、异常退出清理 |
| 后台 memory task 过多 | per-user memory maintenance guard |

## 结论

per-user app-server idle pool 是合理方向，但必须坚持两个原则：

1. 生命周期按用户隔离，不能做全局单例。
2. 不能为了复用进程而破坏同一用户多 session / 多 run 并行能力。

最稳妥的实现路径是先做可关闭的 pool skeleton 和 idle reaper，再通过并发压测决定单 worker 还是 per-user worker pool。这样既能提高 memory pipeline 完成概率，又不会把 Ripple 当前的隔离和并发模型打散。
