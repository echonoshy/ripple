# Ripple Restart Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单实例 `ripple-server` 在保留 NAS SQLite 数据位置的前提下支持 drain、可重放 job 恢复和 TaskSession 终态补投影。

**Architecture:** 继续以 SQLite `jobs.record_json` 为权威来源，保存完整执行请求和恢复元数据；计划内发布让旧实例停止派发新任务并等待活跃任务归零，异常重启则只重放具备完整请求且未超过重试次数的 job。TaskSession 的 Ripple executor 改为引用持久化 job，并由正常等待或启动恢复协调器把 job 终态投影回 TaskRun。

**Tech Stack:** Rust 1.77.2、Tokio、Axum 0.7、SQLx SQLite、Serde JSON。

## Global Constraints

- 不移动、复制、重建或清理 NAS 上的 `.ripple/ripple.sqlite` 数据。
- 任意时刻只允许一个执行实例写入 NAS SQLite；不实现双活。
- 不恢复已移除的 `/v1/tasks` 公共 API。
- 不改变现有 `/v1/runs`、TaskSession、SSE 和 callback 的公开 response shape。
- 生产代码必须先有失败测试，按 RED → GREEN → REFACTOR 执行。
- 不在本轮引入 PostgreSQL、Redis、消息队列、callback outbox 或 exactly-once 承诺。

---

### Task 1: 定义可重放 Job 记录与恢复状态机

**Files:**
- Modify: `crates/ripple-server/src/jobs.rs`
- Test: `crates/ripple-server/src/jobs.rs`

**Interfaces:**
- Produces: `StoredJobReplay`、`StoredJobRecord::requeue_after_restart(record: &mut Value) -> ReplayDecision`、`StoredJobRecord::replay(record: &Value) -> anyhow::Result<StoredJobReplay>`。
- `StoredJobReplay` 保存 `AgentRunCreateRequest`、`user_id`、`session_id`、`workspace_root`、`runtime_dir`、`attempt` 和 `max_attempts`。

- [ ] **Step 1: 写恢复状态机失败测试**

新增测试：完整 replay envelope 的 `running` job 应变为 `queued` 并增加 attempt；缺少 `request` 的历史 job 应变为 `failed`；达到 `max_attempts` 的 job 应变为 `failed/retry_limit_exhausted`。

```rust
#[test]
fn restart_requeues_replayable_running_job() {
    let mut record = replayable_record("running", 1, 2);
    assert_eq!(
        StoredJobRecord::requeue_after_restart(&mut record),
        ReplayDecision::Queued
    );
    assert_eq!(record["status"], "queued");
    assert_eq!(record["attempt"], 2);
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server jobs::tests::restart_requeues_replayable_running_job -- --exact`

Expected: FAIL，因为 `ReplayDecision` 和 `requeue_after_restart` 尚不存在。

- [ ] **Step 3: 实现最小 replay envelope 与状态变换**

为新 job 的 `record_json` 写入完整请求和路径；历史记录保持兼容。状态变换只操作 `record_json`，不新增破坏性 SQLite migration。

- [ ] **Step 4: 运行 jobs 单元测试确认 GREEN**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server jobs::tests -- --nocapture`

Expected: jobs 测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add crates/ripple-server/src/jobs.rs
git commit -m "[ADD] 增加可重放任务记录"
```

### Task 2: 拆分 Job 持久化与派发并支持 drain

**Files:**
- Modify: `crates/ripple-server/src/jobs.rs`
- Modify: `crates/ripple-server/src/storage/jobs.rs`
- Test: `crates/ripple-server/src/jobs.rs`

**Interfaces:**
- Produces: `JobManager::begin_drain()`、`JobManager::is_draining() -> bool`、`JobManager::active_count() -> usize`、`JobManager::wait_for_idle(Duration) -> bool`、`JobManager::recover_interrupted_stored_runs() -> anyhow::Result<RecoveryReport>`、`JobManager::dispatch_recovered_jobs() -> anyhow::Result<usize>`。
- `start()` 在非 drain 状态下保持现有行为；drain 状态下只保存 `queued` 记录。

- [ ] **Step 1: 写 drain 和恢复派发失败测试**

测试 `begin_drain()` 后新 job 保持 `queued` 且不进入内存 active map；测试恢复只选择带 replay envelope 的 `queued/running` job。

- [ ] **Step 2: 运行测试确认 RED**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server jobs::tests::drain_keeps_new_job_queued -- --exact`

Expected: FAIL，因为 drain API 尚不存在。

- [ ] **Step 3: 实现共享 drain 标志与可复用 dispatch**

把当前 `start()` 内的 provider spawn 抽成 `dispatch_job(job, replay)`；使用 `Arc<AtomicBool>` 保存 drain。后台 job 从 `queued` 进入 `running` 时持久化 attempt，不在执行期间写高频心跳。

- [ ] **Step 4: 实现恢复查询**

在 `storage/jobs.rs` 增加 `list_queued_jobs()`；启动恢复先规范化遗留 `queued/running`，再在 router 启动前派发 queued job。

- [ ] **Step 5: 运行相关测试确认 GREEN**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server jobs::tests storage::tests::job_usage_stats_use_sqlite_metadata -- --nocapture`

Expected: 相关测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add crates/ripple-server/src/jobs.rs crates/ripple-server/src/storage/jobs.rs
git commit -m "[ADD] 支持任务排空与重启派发"
```

### Task 3: 把 TaskSession Ripple executor 接入持久化 Job

**Files:**
- Modify: `crates/ripple-server/src/api/task_sessions.rs`
- Modify: `crates/ripple-server/src/storage/task_sessions.rs`
- Modify: `crates/ripple-server/src/storage/schema.rs`
- Test: `crates/ripple-server/tests/api_smoke.rs`

**Interfaces:**
- Produces: `wait_for_task_session_job(...)`、`reconcile_recoverable_task_session_runs(state: AppState) -> anyhow::Result<usize>`。
- TaskRun 的 `external_run_id` 在 job 创建后立即持久化。
- `Storage::list_active_task_session_runs() -> anyhow::Result<Vec<Value>>` 返回 `in_progress` / `waiting_user` 运行记录。

- [ ] **Step 1: 写 TaskSession 持久 job 失败测试**

扩展现有 `task_session_ripple_executor_posts_callback_status` 或新增目标测试：启动 Ripple executor 后，TaskRun 必须在执行完成前已有 `external_run_id`，对应 job 记录必须包含 replay request。

- [ ] **Step 2: 运行目标 smoke 测试确认 RED**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --test api_smoke task_session_ripple_executor_uses_replayable_job -- --exact --nocapture`

Expected: FAIL，因为当前使用 `run_internal()`，不会保存 job。

- [ ] **Step 3: 将内部执行改为持久化 job**

使用 `state.jobs.start(...)` 替换 `run_internal()`；保存 `external_run_id` 后轮询 `info_for_user()` 到终态，再调用现有 `persist_task_run_status_projection()`。

- [ ] **Step 4: 增加启动补投影**

扫描带 `external_run_id` 的活跃 TaskRun；对应 job 已终态时幂等补写 TaskRun、TaskSpec、TaskSession 和事件。对应 job 仍 queued/running 时启动等待协调任务。

- [ ] **Step 5: 运行 TaskSession 目标测试确认 GREEN**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --test api_smoke task_session_ -- --nocapture`

Expected: 两个测试通过。

- [ ] **Step 6: 提交**

```bash
git add crates/ripple-server/src/api/task_sessions.rs crates/ripple-server/src/storage/task_sessions.rs crates/ripple-server/src/storage/schema.rs crates/ripple-server/tests/api_smoke.rs
git commit -m "[ADD] 持久化任务会话执行"
```

### Task 4: 增加 drain 管理接口、readiness 和调度停发

**Files:**
- Create: `crates/ripple-server/src/api/internal.rs`
- Modify: `crates/ripple-server/src/api/mod.rs`
- Modify: `crates/ripple-server/src/api/health.rs`
- Modify: `crates/ripple-server/src/services/task_triggers.rs`
- Modify: `crates/ripple-server/src/services/tasks.rs`
- Test: `crates/ripple-server/src/api/mod.rs`

**Interfaces:**
- Produces: `POST /v1/internal/drain`、`GET /v1/internal/drain/status`。
- Status body: `{ "draining": bool, "active_jobs": usize }`。

- [ ] **Step 1: 写管理接口失败测试**

测试调用 drain 前 readiness 为 200；调用 drain 后 status 返回 `draining=true`，readiness 返回 503，且调度 helper 不执行触发函数。

- [ ] **Step 2: 运行测试确认 RED**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server api::tests::drain_marks_server_not_ready -- --exact`

Expected: FAIL，因为 internal 路由和 drain-aware readiness 尚不存在。

- [ ] **Step 3: 实现受现有 API key 保护的 internal 路由**

将 internal 路由加入 `protected_v1`，不开放匿名调用；返回固定 JSON shape。

- [ ] **Step 4: 让 readiness 与后台循环感知 drain**

`health::ready()` 在基础诊断成功但 draining 时返回 503；两个 task trigger loop 在每次 tick 后先检查 `state.jobs.is_draining()`，drain 时跳过扫描。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server api::tests::drain_ -- --nocapture`

Expected: 两个测试通过。

- [ ] **Step 6: 提交**

```bash
git add crates/ripple-server/src/api/internal.rs crates/ripple-server/src/api/mod.rs crates/ripple-server/src/api/health.rs crates/ripple-server/src/services/task_triggers.rs crates/ripple-server/src/services/tasks.rs
git commit -m "[ADD] 增加服务排空控制"
```

### Task 5: 让服务启动和退出执行恢复/排空协议

**Files:**
- Modify: `crates/ripple-server/src/lib.rs`
- Test: `crates/ripple-server/tests/api_smoke.rs`

**Interfaces:**
- `serve_with_listener()` 启动顺序：初始化 state → 恢复 record → 派发 queued → 恢复 TaskSession 投影 → 启动 router。
- 退出顺序：begin drain → 停止调度 → 等待 active jobs 或超时 → 结束进程。

- [ ] **Step 1: 写服务重启恢复失败测试**

创建临时 SQLite，写入可重放 `running` job，启动新 server，验证 job attempt 增加且最终进入终态；另写 drain 后 queued job 在下次启动被派发的测试。

- [ ] **Step 2: 运行目标测试确认 RED**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --test api_smoke restart_requeues_replayable_job -- --exact --nocapture`

Expected: FAIL，因为 server 启动还未派发恢复 job。

- [ ] **Step 3: 实现启动与退出编排**

修改 `serve_with_listener()`；保留现有 `with_graceful_shutdown`，但 shutdown future 触发时先设置 drain。等待上限使用固定 30 秒，超时日志明确说明任务将在下次启动重放。

- [ ] **Step 4: 运行目标测试确认 GREEN**

Run: `PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --test api_smoke restart_ -- --nocapture`

Expected: 两个测试通过。

- [ ] **Step 5: 提交**

```bash
git add crates/ripple-server/src/lib.rs crates/ripple-server/tests/api_smoke.rs
git commit -m "[ADD] 编排服务重启任务恢复"
```

### Task 6: 文档、格式和完整验证

**Files:**
- Create: `docs/operations/restart-recovery.md`
- Modify: `docs/BACKEND_ARCHITECTURE.md`

**Interfaces:**
- 文档给出 build → drain → status → stop/start → health 的操作顺序，并明确数据仍在 NAS。

- [ ] **Step 1: 写运维文档**

包含示例：

```bash
curl -fsS -X POST -H "X-API-Key: $RIPPLE_API_KEY" http://127.0.0.1:8810/v1/internal/drain
curl -fsS -H "X-API-Key: $RIPPLE_API_KEY" http://127.0.0.1:8810/v1/internal/drain/status
```

- [ ] **Step 2: 运行格式、编译和核心测试**

Run:

```bash
PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo fmt -p ripple-server --check
PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo check -p ripple-server
PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --lib
```

Expected: 全部 exit 0；核心单测 0 failures。

- [ ] **Step 3: 运行目标集成测试和 diff 检查**

Run:

```bash
PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --test api_smoke restart_ -- --nocapture
PATH=/root/.cargo/bin:/root/.local/bin:$PATH cargo test -p ripple-server --test api_smoke task_session_ -- --nocapture
git diff --check
```

Expected: 新增目标测试全部通过，`git diff --check` 无输出。

- [ ] **Step 4: 记录既有 smoke 失败，不恢复旧 API**

完整 `cargo test -p ripple-server` 若仍只失败于已移除 `/v1/tasks` 路由的既有 404 测试，在交付说明中列出；本任务不得修改路由来消除它们。

- [ ] **Step 5: 提交文档**

```bash
git add docs/operations/restart-recovery.md docs/BACKEND_ARCHITECTURE.md
git commit -m "[DOCS] 记录任务恢复发布流程"
```
