# 定时任务实现设计

本文档用于指导 ripple 后续把现有定时任务 MVP 演进为可长期运行的多用户安全调度系统。当前目标不是一次性复刻 openclaw 的完整 Cron 子系统，而是明确必要的技术细节、风险边界和分阶段实现路线。

## 背景与现状

当前实现由 `SchedulerManager` 在 Server 进程内启动一个后台 loop，每 5 秒扫描所有 user sandbox 下的定时任务文件：

```text
.ripple/sandboxes/<user_id>/scheduled-tasks/jobs.json
.ripple/sandboxes/<user_id>/scheduled-tasks/runs/<job_id>/<run_id>.json
```

任务分两类：

- `execution_type="command"`：通过 `run_sandbox_command()` 进入当前 user 的 nsjail sandbox 执行。
- `execution_type="agent"`：Server 进程内运行 agent loop；agent 调用 Bash/Read/Write 等工具时使用当前 user 的 sandbox context。

当前能力足够支持简单 reminder、interval command、agent prompt，但还缺少生产级调度所需的持久运行状态、重启恢复、失败退避、通知交付和 run history 管理。

## 设计目标

1. 不同 user 的任务定义、运行记录、执行结果不能被其他 user 读取。
2. 定时任务在重启、崩溃、长时间运行、任务失败时有明确状态。
3. command 任务始终在对应 user sandbox 中执行。
4. agent 任务有明确的 session 语义：隔离执行、绑定当前 session、或绑定命名持久 session。
5. 客户端可以知道任务创建、开始、完成、失败等状态。
6. 敏感信息允许当前 user 查看，但不能跨 user 泄漏；列表接口尽量避免默认暴露完整敏感 payload。
7. 实现路径尽量渐进，先补可靠性和安全边界，再扩展 cron/timezone/delivery 等能力。

## 安全模型

### 必须保证的边界

API 层、存储层、执行层都必须以 `user_id` 为隔离主键。

API 层：

- 所有 schedule API 只能访问当前已认证主体对应的 `user_id`。
- 不允许从请求 body 接受 `user_id`。
- `job_id` 和 `run_id` 只能在当前 `user_id` 的目录下解析。

存储层：

- 所有路径必须经过 `SandboxConfig.sandbox_dir(user_id)`，继续使用 `validate_user_id()` 防路径穿越。
- 定时任务文件存放在 user sandbox 内：

```text
sandboxes/<user_id>/scheduled-tasks/
```

执行层：

- command job 只挂载当前 user 的 workspace 到 `/workspace`。
- agent job 创建 ToolUseContext 时必须传入当前 `user_id`、当前 user workspace 和当前 user sandbox manager。
- 不允许定时任务工具直接读取其他 user 的 `scheduled-tasks`、`sessions` 或 `credentials`。

### user_id 信任边界

当前阶段保持现有设计：`X-Ripple-User-Id` 由上游业务系统传入，ripple 只负责校验字符集并按该 user_id 做数据和 sandbox 隔离。ripple 不在本层实现身份鉴权，也不把 API key 与 user_id 绑定。

因此，多用户安全的前置假设是：上游必须保证传入的 `X-Ripple-User-Id` 可信，且终端用户不能任意伪造其他用户的 user_id。本文档后续设计均基于这个前提，不改变当前 user_id 传递方式。

### 文件权限

建议创建目录和写文件时显式设置权限：

- `sandboxes/<user_id>`：`0700`
- `scheduled-tasks/`：`0700`
- `credentials/`：`0700`
- `jobs.json`、`jobs-state.json`、run log：`0600`

这不能替代 API 鉴权，但能降低宿主机同用户/同机误读风险。

## 存储设计

当前 `jobs.json` 同时保存任务配置和运行状态。后续建议拆分：

```text
scheduled-tasks/
  jobs.json              # 用户可编辑/可展示的任务定义
  jobs-state.json        # 运行时状态
  runs/
    <job_id>.jsonl       # 推荐：每个 job 一个 append-only run log
```

### Job 定义

建议的 job 定义字段：

```python
class ScheduledJob(BaseModel):
    id: str
    user_id: str
    name: str
    description: str | None = None

    execution_type: Literal["command", "agent"]
    command: str | None = None
    prompt: str | None = None

    schedule: ScheduleSpec
    enabled: bool = True
    timeout_seconds: int | None = 300

    session_policy: SessionPolicy = "isolated"
    created_from: Literal["chat", "ui", "api"]
    created_session_id: str | None = None
    delivery: DeliverySpec | None = None

    created_at: datetime
    updated_at: datetime
```

### ScheduleSpec

第一阶段可以保留现有 `once` 和 `interval`，但新模型建议直接向三类 schedule 收敛：

```python
ScheduleSpec = (
    OnceSchedule |
    IntervalSchedule |
    CronSchedule
)

class OnceSchedule(BaseModel):
    kind: Literal["once"]
    run_at: datetime

class IntervalSchedule(BaseModel):
    kind: Literal["interval"]
    interval_seconds: int
    anchor_at: datetime | None = None

class CronSchedule(BaseModel):
    kind: Literal["cron"]
    expr: str
    timezone: str | None = None
    stagger_seconds: int | None = None
```

Cron 表达式必须按指定 timezone 的本地 wall-clock 解释，不要先转换成 UTC 再写表达式。

### Runtime state

运行状态建议从 job 定义中拆出去：

```python
class ScheduledJobState(BaseModel):
    job_id: str
    next_run_at: datetime | None = None
    running_at: datetime | None = None
    current_run_id: str | None = None
    last_run_at: datetime | None = None
    last_status: Literal["success", "failed", "skipped", "cancelled", "timeout"] | None = None
    last_error: str | None = None
    last_duration_ms: int | None = None
    consecutive_errors: int = 0
    consecutive_skipped: int = 0
    schedule_error_count: int = 0
    updated_at: datetime
```

拆分的好处：

- 用户编辑 `jobs.json` 不会误改运行状态。
- 可以将敏感 prompt/command 与频繁变化的 runtime 状态分开管理。
- 后续支持 git 管理 job 定义时，state 文件可 gitignore。

### Run 记录

推荐从“每次 run 一个 JSON 文件”改为“每个 job 一个 JSONL run log”：

```python
class ScheduledRun(BaseModel):
    id: str
    job_id: str
    user_id: str
    status: Literal["running", "success", "failed", "skipped", "cancelled", "timeout"]
    started_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None

    exit_code: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: str | None = None
    summary: str | None = None

    session_id: str | None = None
    delivery_status: Literal["not_requested", "delivered", "failed", "unknown"] = "not_requested"
```

必须实现 retention：

- 每个 job 最多保留 N 条 run，例如 2000。
- 或每个 job 的 run log 最大 M bytes，例如 2 MB。
- 超限时保留最新记录。

## 调度循环

### 当前模型

当前是固定 5 秒全量扫描：

```text
loop:
  tick()
  sleep(5s)
```

优点是简单。缺点是 user/job 多时有重复 IO，且运行中状态只存在内存。

### 推荐模型

第一阶段可以继续保留 5 秒 tick，但必须增加持久 running marker：

1. tick 发现 due job。
2. 在锁内检查 state：
   - disabled：跳过。
   - running_at 存在：跳过或判断 stuck。
   - next_run_at 未到：跳过。
3. 创建 run。
4. 持久化：
   - `state.running_at = now`
   - `state.current_run_id = run.id`
   - run status = `running`
5. 释放锁，执行任务。
6. 执行完成后重新加锁，写入 run 终态，更新 state：
   - 清空 `running_at/current_run_id`
   - 写 `last_run_at/last_status/last_error`
   - 计算下一次 `next_run_at`

第二阶段可以改为 next-wake timer：

```text
arm timer to min(next_run_at)
timer fires -> collect due jobs -> execute -> recompute -> re-arm
```

即使改为 timer，也建议保留最大 60 秒 maintenance recheck，用于处理时钟跳变、文件外部编辑、stuck running marker。

## 重启恢复

Server 启动时必须扫描 state：

1. 如果发现 `running_at/current_run_id`：
   - 读取对应 run。
   - 如果 run 仍是 `running`，标记为 `failed` 或 `cancelled`。
   - 错误写为：`scheduler interrupted by server restart`。
   - 清空 running marker。
2. 对 one-shot job：
   - 如果上次是 success，且没有更新 schedule，不再运行。
   - 如果上次是失败，可以按 retry 策略决定是否重试。
3. 对 interval/cron job：
   - 如果 missed，可以选择 catch-up。
   - 默认建议只补最近一次，避免重启后任务风暴。

建议增加配置：

```yaml
scheduler:
  max_missed_jobs_per_restart: 5
  missed_job_stagger_seconds: 5
  startup_defer_agent_jobs_seconds: 120
```

## 并发控制

至少需要三层并发控制：

1. 同一 job 不允许并发执行：
   - 用持久 `running_at` 保证跨 tick、跨重启可见。
2. 同一 user 的 workspace 修改互斥：
   - command job 继续使用 `sandbox_manager.user_lock(user_id)`。
   - agent job 的工具调用也应复用 user lock。
3. 全局 scheduler 并发上限：
   - 避免大量 due jobs 同时启动 agent run。

建议配置：

```yaml
scheduler:
  max_concurrent_runs: 4
  max_concurrent_runs_per_user: 1
```

`concurrency_policy` 后续可以扩展：

- `skip`：如果上一次还在跑，本次跳过。
- `queue`：排队执行。
- `replace`：取消旧 run，启动新 run。

第一阶段建议只支持 `skip`。

## 失败与重试

当前失败后只更新 `last_status`，没有 backoff。建议：

### interval/cron job

连续失败时应用退避：

```text
30s, 60s, 5m, 15m, 1h
```

下一次执行时间取：

```text
max(schedule_next_run, now + backoff)
```

避免失败任务高频刷资源。

### once job

once job 成功后：

- 默认删除或 disabled。
- 为了可审计，建议先 disabled 并保留 run history；UI 可以提供 “delete completed one-shot jobs”。

once job 失败后：

- 对明显 transient error 可重试，例如 rate limit、网络错误、timeout、5xx。
- 超过 `max_attempts` 后 disabled，保留错误。

### timeout/cancel

command job 已有 timeout 参数。agent job 也应该支持 timeout：

- timeout 到达时取消 agent run。
- run status 写 `timeout`。
- state 清空 running marker。

## Agent session 语义

当前 agent schedule 每次创建一个 `sched-<job_id>-<run_id>` session。建议明确支持三种 session policy：

```python
SessionPolicy = Literal["isolated", "created_session", "named"]
```

- `isolated`：每次 run 都创建新 session。适合报告、查询、外部动作。
- `created_session`：绑定创建该任务的 chat session。适合“稍后在这个对话里提醒我”。
- `named`：绑定一个持久命名 session，例如 `schedule:<job_id>` 或用户指定 id。适合周期性累积上下文的任务。

创建自 chat 的任务应记录：

```python
created_session_id: str
created_message_id: str | None
```

如果后续要推送结果回原对话，必须有 `created_session_id` 或 delivery target。

## Delivery 与客户端通知

当前执行完成后只写 run 记录，不主动通知原 session。用户必须打开 Scheduled Tasks 面板轮询。

建议引入 delivery：

```python
class DeliverySpec(BaseModel):
    mode: Literal["none", "session", "webhook"] = "session"
    session_id: str | None = None
    webhook_url: str | None = None
    notify_on: list[Literal["started", "success", "failed", "timeout"]] = ["failed", "success"]
```

### session delivery

执行完成后向目标 session 写入一个 system/event message，例如：

```text
Scheduled task "Daily brief" finished: success
Summary:
...
```

注意：

- 这条消息应标记为 scheduler event，避免被误认为用户消息。
- 如果 session 正在 SSE 连接中，应推送事件。
- 如果 session 不在线，只写入 session history，用户下次打开能看到。

### SSE 事件

建议新增 scheduler event：

```json
{
  "type": "schedule_run_started",
  "data": {
    "job_id": "...",
    "run_id": "...",
    "name": "..."
  }
}
```

```json
{
  "type": "schedule_run_finished",
  "data": {
    "job_id": "...",
    "run_id": "...",
    "status": "success",
    "summary": "..."
  }
}
```

如果没有建立 websocket/SSE 事件总线，第一阶段可以继续轮询 Scheduled Tasks 面板，但必须在文档和 UI 中明确：后台任务完成不会自动出现在原 chat。

## API 设计

现有 API 可以保留：

```http
POST   /v1/sandbox/schedules
GET    /v1/sandbox/schedules
GET    /v1/sandbox/schedules/{job_id}
PATCH  /v1/sandbox/schedules/{job_id}
DELETE /v1/sandbox/schedules/{job_id}
POST   /v1/sandbox/schedules/{job_id}/run
GET    /v1/sandbox/schedules/{job_id}/runs
GET    /v1/sandbox/schedules/{job_id}/runs/{run_id}
```

建议调整：

1. list 默认不返回完整 `command` 和 `prompt`，只返回摘要：
   - `has_command`
   - `has_prompt`
   - `prompt_preview`
2. get detail 返回完整敏感字段，但必须通过当前 user 授权。
3. run now 默认返回 quickly：
   - 自动执行可以后台跑。
   - 手动 run 可以支持 `wait=true|false`。
4. 增加 status endpoint：

```http
GET /v1/sandbox/schedules/status
```

返回 scheduler 是否启用、in-flight run 数、下一次 wake 时间。

## 前端设计

当前 Scheduled Tasks 面板每 5 秒轮询 schedules 和 runs。短期可以保留。

需要补充：

- 显示 `running` run。
- 显示 `last_error` 和失败次数。
- 显示 `next_run_at`、`last_run_at`、duration。
- 对敏感 `command/prompt/stdout/stderr` 默认折叠。
- 支持查看完整 run detail。
- 如果引入 session delivery，在 chat 中展示 scheduler event。

## 权限与脱敏策略

用户读取自己的敏感信息是允许的。因此脱敏不是为了阻止当前 user，而是为了降低误展示和列表泄漏风险。

建议：

- list API 默认不返回完整 prompt/command/stdout/stderr。
- detail API 返回完整内容。
- 日志中不要记录完整 command/prompt/stdout/stderr。
- run error 可以返回给当前 user，但 server log 中应截断。

## 分阶段实现路线

### Phase 1：可靠性地基

- 新增 `jobs-state.json` 或在现有 jobs 中增加持久 `running_at/current_run_id`。
- run 开始前持久化 running marker。
- Server 启动时恢复 interrupted run。
- shutdown 时追踪 in-flight scheduler tasks，取消或等待并写终态。
- 文件权限改为 `0700/0600`。
- 加 run retention。

### Phase 2：API 安全与敏感信息展示

- list API 默认隐藏完整敏感 payload。
- 增加审计日志：user_id、job_id、run_id、action。
- 保持 `X-Ripple-User-Id` 由上游传入的现有模式。

### Phase 3：调度能力

- 引入 `ScheduleSpec`。
- 支持 cron expression + timezone。
- interval 增加 anchor。
- 增加 missed job catch-up 策略和 startup stagger。

### Phase 4：失败策略与并发

- 增加 consecutive error count。
- interval/cron 失败 backoff。
- once transient retry。
- 全局和 per-user concurrency limit。
- stuck running marker 清理。

### Phase 5：通知与 session 绑定

- job 记录 `created_session_id`。
- 支持 `delivery.mode=session|webhook|none`。
- 完成后写 scheduler event 到目标 session。
- SSE 推送 schedule run started/finished。

## 测试清单

### 安全隔离

- user A 创建 schedule，user B list/get/run/delete 均不可见。
- user B 猜测 user A 的 job_id，返回 404。
- 非法 user_id，如 `../alice`，返回 400。
- 在当前信任模型下，同一请求解析出的 user_id 只能访问自己的 schedules/runs。

### 执行隔离

- command job 只能读写当前 user workspace。
- command job 不能读取其他 user workspace。
- agent job 的工具 context 使用当前 user workspace。
- 两个 user 同时运行任务，不互相阻塞，除共享全局并发限制外。

### 状态恢复

- run 开始后 kill server，重启后 run 被标记 interrupted。
- running marker 清理后 job 可以再次执行。
- shutdown 时 in-flight run 不会永久停在 running。

### 调度语义

- once job 成功后不重复执行。
- interval job 失败后应用 backoff。
- cron timezone 表达式按本地 wall-clock 生效。
- disabled job 不会执行。

### 客户端可见性

- Scheduled Tasks 面板能看到 running -> success/failed。
- run detail 展示 stdout/stderr/error/summary。
- session delivery 能把完成事件写回创建它的 session。

## 与 openclaw 的可借鉴点

openclaw 的 Cron 子系统值得借鉴的核心不是具体 TypeScript 实现，而是几个设计原则：

- 配置和 runtime state 分离。
- 执行前持久化 running marker。
- 启动时恢复 interrupted runs。
- read-only 操作不应意外推进 past-due schedule。
- 失败 backoff 和一次性任务 retry。
- 按 next wake 计时，而不是只靠固定全量扫描。
- 定时 agent run 应有明确 delivery 和 session target。

ripple 可以按上述原则渐进实现，不需要一次性引入所有复杂度。
