# Ripple 重启任务恢复设计

## 目标

在不迁移、不重写现有 NAS 数据的前提下，让 `ripple-server` 支持安全的“排空后快速重启”：计划内发布等待当前任务完成，异常重启把可重放任务重新入队，而不是直接标记失败。

## 范围

本轮只实现最小后端能力：

- SQLite 仍是权威数据源，位置和现有 NAS 目录保持不变。
- 任意时刻只运行一个会执行任务、写入 SQLite 的 `ripple-server` 实例。
- `/v1/runs` 创建的 Codex job 保存完整的可重放请求。
- TaskSession 的 Ripple executor 通过同一套持久化 job 执行，并保存 `external_run_id` 关联。
- 服务启动时把遗留的 `queued` / `running` job 恢复为可再次派发的 `queued` job。
- 增加进程内 drain 状态：drain 期间不派发新 job、不触发新的定时任务，已有 job 继续完成。
- 增加仅本机管理使用的 drain 状态接口，不改变现有公开业务 API shape。
- 优雅退出等待受 JobManager 跟踪的活跃 job 归零。

本轮不包含：

- PostgreSQL、Redis、消息队列或多主协调。
- 两个实例同时执行任务或同时写 NAS SQLite。
- Codex turn 在进程之间原地迁移。
- 任意外部副作用的 exactly-once 保证。
- callback outbox；它作为后续独立增强处理。

## 运行语义

### 正常运行

创建 job 时，Server 先把完整 `AgentRunCreateRequest`、用户、session、workspace 和 runtime 路径写入 SQLite，再启动后台执行。正常执行路径只增加一次持久化写入；流式事件和 token 不增加高频数据库同步。

### 计划内发布

1. 提前构建新二进制。
2. 对旧服务调用 drain。
3. 旧服务停止派发新 job；新请求可以持久化为 `queued`。
4. 旧服务继续完成已有 job。
5. 活跃 job 归零后退出旧服务。
6. 启动新服务；新服务恢复并派发 drain 期间积累的 `queued` job。

发布过程允许几秒钟进程切换窗口，不追求双实例零停机。

### 异常重启

启动时不再把遗留 job 统一标记为 `failed/interrupted_by_restart`。可重放 job 转为 `queued`，真正再次派发时才增加 `attempt`。缺少完整重放请求的历史 job 仍标记为失败，避免用不完整输入误执行。

恢复属于 at-least-once：任务可能从头重新执行。调用外部非幂等操作的任务需要调用方提供 `client_request_id` / `idempotency_key`，或在后续版本增加安全检查点。

## 数据模型

继续复用 `jobs.record_json`，不迁移现有行，也不要求立即增加 SQLite 列。新记录在 JSON 中增加：

- `request`: 完整 `AgentRunCreateRequest`。
- `workspace_root`: 执行 workspace 根目录。
- `runtime_dir`: run artifact 根目录。
- `attempt`: 已启动的执行次数，首次执行为 `1`。
- `max_attempts`: 本轮固定为 `2`，即异常重启最多自动重试一次。
- `recovery_reason`: 恢复原因，例如 `interrupted_by_restart`。

旧记录没有这些字段时保持可读，不执行破坏性 schema 迁移。

## 组件修改

### JobManager

- 将“创建持久记录”和“派发执行”拆成可复用边界。
- 保存重放 job 所需的完整请求与路径。
- 提供 `recover_interrupted_stored_runs()`：只重新入队可重放且未超过最大次数的 job。
- 提供 `dispatch_recovered_jobs()`：服务启动完成后派发恢复记录。
- 提供 `active_count()`、`is_draining()`、`begin_drain()` 和 `wait_for_idle()`。
- drain 后新 job 只持久化为 `queued`，不启动 provider。

### AppState 与健康检查

- drain 状态放在共享 `AppState` / `JobManager` 中。
- readiness 在 drain 时返回 `503` 并包含稳定的 `draining` 状态，不暴露主机路径。
- 增加受现有服务鉴权保护、且部署侧只从本机调用的 `/v1/internal/drain` 与 `/v1/internal/drain/status`。

### TaskSession 执行投影

- `run_ripple_task_execution()` 不再调用非持久化的 `run_internal()`，改为创建持久化 job。
- TaskRun 在 job 创建后立即保存 `external_run_id`，正常路径等待 job 终态并复用现有投影逻辑。
- 服务启动后扫描仍处于 `in_progress` 且带 `external_run_id` 的 TaskRun；对应 job 完成后补做 TaskRun、TaskSpec、TaskSession 和事件投影。
- 投影更新必须幂等，重复恢复不会追加不一致的终态。

### 后台调度

- task trigger 和 task action 循环在 drain 后跳过新的触发扫描。
- 已经启动的 job 不取消，继续运行到终态。

### 退出流程

- 收到 `SIGTERM` / `Ctrl-C` 后先进入 drain。
- 等待受跟踪 job 归零，等待时间由固定上限保护；超时则退出并依赖下次启动恢复。
- 不改变 NAS 路径，不复制或清理现有 SQLite 文件。

## 错误处理

- 重放请求缺失：标记 `failed`，保留 `interrupted_by_restart` 原因。
- 达到最大尝试次数：标记 `failed`，错误写为 `retry_limit_exhausted`。
- 重放参数解析失败：标记 `failed`，不得 panic。
- drain 期间新 job：返回正常的 job 信息，状态为 `queued`。
- 恢复派发失败：保持为 `queued` 并记录错误，下一次显式恢复或重启可以再次处理。

## 验证

- 单元测试先证明旧逻辑会把运行 job 标记失败，再验证新逻辑会重新入队可重放 job。
- 测试 drain 后新 job 不启动 provider、状态保持 `queued`。
- 测试 readiness 在 drain 时返回 `503`。
- 测试历史 job 缺少 `request` 时不会被盲目重放。
- 测试 TaskSession Ripple executor 使用持久化 job，并能在恢复后完成状态投影。
- 运行 `cargo fmt -p ripple-server`、`cargo check -p ripple-server`、`cargo test -p ripple-server --lib`。
- 集成 smoke 中当前分支已存在的旧 Tasks 路由 404 失败单独记录，不通过恢复已移除 API 来规避。

## 部署边界

本轮只提交代码与部署说明，不直接操作线上 NAS 数据、不替换当前 `8810` 进程。上线时必须先构建、调用 drain、观察活跃 job 归零，再执行单实例 stop/start 和健康检查。
