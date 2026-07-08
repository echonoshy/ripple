# Task Center API Integration Guide

本文面向接入 Vitana/Ripple 任务中心的客户端、上游业务系统和外部执行器。任务中心的公开主入口是 `/v1/task-sessions`，不要再调用旧 `/v1/tasks`。

## 结论

- 新任务中心只围绕 `TaskSession`、`TaskSpec`、`TaskRun` 和 `Confirmation` 四类资源对接。
- 普通聊天 session 仍走 `/v1/responses` 和 `/v1/sessions`；如果一个任务来自普通 session，用 `source_surface: "session"` 和 `source_id: "<session_id>"` 把 TaskSession 关联回原会话。
- `/v1/tasks`、`/v1/tasks/:task_id/*` 和 `/v1/task-triggers` 已不再公开注册。
- `GET /v1/sessions/:session_id/tasks` 仅作为 session 兼容只读接口保留，新任务中心不要用它构建主体验。
- 当前 `TaskRun` 是产品层执行投影。真正执行可以由上游业务系统、Ripple `/v1/runs` 或其他 worker 完成，再把执行状态回写到 TaskRun。
- 调用方通过 `GET /v1/task-sessions/:session_id/events/stream` 订阅任务状态，不需要轮询详情接口。

## Auth

所有受保护接口都需要鉴权：

```bash
BASE_URL="http://127.0.0.1:8810/v1"
API_KEY="<server-api-key>"
USER_ID="<user-id>"
```

服务级调用推荐：

```bash
-H "X-API-Key: $API_KEY" \
-H "X-Ripple-User-Id: $USER_ID"
```

如果启用了浏览器用户登录，也可以用：

```bash
-H "Authorization: Bearer <user-session-token>"
```

生产推荐由 trusted proxy 注入真实 `X-Ripple-User-Id`，不要让浏览器客户端直接持有 server API key。

## Data Model

### TaskSession

任务中心列表里的主对象。它表示一个持续存在的任务会话，而不是一次执行。

关键字段：

```json
{
  "session_id": "ts-xxxx",
  "title": "整理客户方案",
  "status": "pending_confirm",
  "source_surface": "session",
  "source_id": "srv-xxxx",
  "task_type": "todo",
  "goal": "把会议纪要整理成可执行方案",
  "executor": "vitana",
  "latest_message": "等待确认 TaskSpec",
  "needs_user_action": true,
  "current_task_spec_id": "spec-xxxx",
  "current_run_id": null,
  "latest_run_id": "run-xxxx",
  "created_at": "2026-07-08T08:00:00Z",
  "updated_at": "2026-07-08T08:10:00Z"
}
```

对外状态：

| status | 含义 |
| --- | --- |
| `pending_confirm` | TaskSpec 已生成，等待用户确认 |
| `in_progress` | 已确认或正在执行 |
| `waiting_user` | 等待用户补充信息、授权或确认 |
| `completed` | 任务完成 |
| `cancelled` | 任务取消 |
| `failed` | 任务失败 |

### TaskSpec

执行前的结构化规格。客户端应先让用户确认 TaskSpec，再启动执行。

关键字段：

```json
{
  "task_spec_id": "spec-xxxx",
  "session_id": "ts-xxxx",
  "task_type": "todo",
  "goal": "把会议纪要整理成可执行方案",
  "required_fields": {},
  "source_refs": [],
  "risk_level": "low",
  "impact_summary": "确认后会生成客户方案草稿。",
  "status": "pending_confirm"
}
```

### TaskRun

一次执行投影。它可以映射到 Ripple `/v1/runs`、上游业务 job 或外部 worker。

关键字段：

```json
{
  "run_id": "run-xxxx",
  "session_id": "ts-xxxx",
  "task_spec_id": "spec-xxxx",
  "status": "in_progress",
  "executor": "vitana",
  "external_run_id": "job-xxxx",
  "result_summary": null,
  "failure_reason": null
}
```

TaskRun 状态：

```text
in_progress
waiting_user
completed
cancelled
failed
```

### Confirmation

统一确认卡。用于授权、人工输入、单选/多选、内容审核和异常恢复。

```json
{
  "confirmation_id": "conf-xxxx",
  "session_id": "ts-xxxx",
  "title": "是否允许发送邮件？",
  "confirmation_type": "allow_deny",
  "critical": true,
  "status": "requested"
}
```

确认卡状态：

```text
requested
accepted
rejected
cancelled
```

## Recommended Flow

### 1. 创建 TaskSession

最小创建：

```bash
curl -sS "$BASE_URL/task-sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "整理客户方案",
    "source_surface": "web_task_tab",
    "task_type": "todo",
    "goal": "把会议纪要整理成可执行方案",
    "executor": "vitana",
    "initial_message": "把会议纪要整理成可执行方案"
  }'
```

响应：

```json
{
  "task_session": {
    "session_id": "ts-xxxx",
    "status": "pending_confirm",
    "title": "整理客户方案"
  },
  "task_spec": null
}
```

如果调用方已经有结构化规格，可以创建时带 `task_spec`：

```bash
curl -sS "$BASE_URL/task-sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "整理客户方案",
    "source_surface": "session",
    "source_id": "srv-xxxx",
    "task_type": "todo",
    "goal": "把会议纪要整理成可执行方案",
    "executor": "vitana",
    "task_spec": {
      "task_type": "todo",
      "goal": "把会议纪要整理成可执行方案",
      "risk_level": "low",
      "impact_summary": "会读取当前会话内容并生成方案草稿。",
      "required_fields": {},
      "source_refs": [
        { "type": "session", "id": "srv-xxxx" }
      ]
    }
  }'
```

### 2. 列表和详情

任务中心列表：

```bash
curl -sS "$BASE_URL/task-sessions?limit=50" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID"
```

响应 shape：

```json
{
  "task_sessions": [],
  "count": 0,
  "next_cursor": null
}
```

详情：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID"
```

响应 shape：

```json
{
  "task_session": {},
  "task_specs": [],
  "runs": [],
  "events": [],
  "confirmations": []
}
```

### 3. 生成 TaskSpec

如果创建 TaskSession 时没带 `task_spec`，后续创建：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "task_type": "todo",
    "goal": "把会议纪要整理成可执行方案",
    "risk_level": "low",
    "impact_summary": "会生成客户方案草稿。",
    "required_fields": {},
    "source_refs": []
  }'
```

创建后 TaskSession 会投影为：

```json
{
  "status": "pending_confirm",
  "needs_user_action": true,
  "current_task_spec_id": "spec-xxxx"
}
```

### 4. 用户确认 TaskSpec

只确认，不启动：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs/$TASK_SPEC_ID/confirm" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "start_run": false }'
```

确认并立即创建 TaskRun：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs/$TASK_SPEC_ID/confirm" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "start_run": true }'
```

### 5. 启动 TaskRun

如果 TaskSpec 已确认：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs/$TASK_SPEC_ID/runs" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "executor": "vitana",
    "metadata": {
      "client_req_id": "req-123"
    }
  }'
```

如果调用方希望在同一步确认并启动，可传：

```json
{ "confirm": true }
```

未确认且不带 `confirm: true` 时返回 `409 task_spec_confirmation_required`。

如果 TaskRun 对应一个真实外部 job，把 job id 写进投影：

```json
{
  "executor": "external_worker",
  "external_run_id": "job-123"
}
```

### 6. 回写 TaskRun 状态

完成：

```bash
curl -sS -X PATCH "$BASE_URL/task-sessions/$TASK_SESSION_ID/runs/$RUN_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "completed",
    "result_summary": "已生成客户方案草稿。"
  }'
```

等待用户：

```bash
curl -sS -X PATCH "$BASE_URL/task-sessions/$TASK_SESSION_ID/runs/$RUN_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "waiting_user",
    "result_summary": "需要用户补充客户预算。"
  }'
```

失败：

```bash
curl -sS -X PATCH "$BASE_URL/task-sessions/$TASK_SESSION_ID/runs/$RUN_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "failed",
    "failure_reason": "外部服务授权已失效。"
  }'
```

取消：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/runs/$RUN_ID/cancel" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "cancelled_by_user" }'
```

状态回写会同步更新 TaskSession 和 TaskSpec 的投影状态。

### 7. 创建和响应确认卡

创建确认卡：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/confirmations" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "是否允许继续执行？",
    "confirmation_type": "allow_deny",
    "critical": true,
    "payload": {
      "reason": "需要确认执行范围"
    }
  }'
```

创建后 TaskSession 会投影为：

```json
{
  "status": "waiting_user",
  "needs_user_action": true
}
```

接受：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/confirmations/$CONFIRMATION_ID/respond" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "allow" }'
```

拒绝：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/confirmations/$CONFIRMATION_ID/respond" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "deny" }'
```

如果 `critical: true` 且被拒绝，TaskSession 会投影为 `cancelled`。非关键确认被拒绝时，TaskSession 可回到 `in_progress`。

## 订阅任务状态 SSE

调用方不需要轮询任务状态。创建 TaskSession 后，订阅这个接口：

```bash
curl -N "$BASE_URL/task-sessions/$TASK_SESSION_ID/events/stream?from_start=true" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Accept: text/event-stream"
```

响应头：

```http
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

服务端推送的主事件名是 `task.status`。`data.type` 固定为 `task_status`：

```text
event: task.status
id: 12
data: {"type":"task_status","event_version":1,"event_id":"evt_xxx","sse_id":12,"created_at":"2026-07-08T08:12:00Z","task_session_id":"ts_xxx","session_id":"ts_xxx","event_type":"task_run_started","task_status":"in_progress","needs_user_action":false,"task_spec_id":"spec_xxx","task_spec_status":"in_progress","run_id":"run_xxx","run_status":"in_progress","external_run_id":"job_xxx","confirmation_id":null,"confirmation_status":null,"latest_message":"正在执行","result_summary":null,"failure_reason":null,"task_session":{"session_id":"ts_xxx","title":"整理客户方案","status":"in_progress","needs_user_action":false,"current_task_spec_id":"spec_xxx","current_run_id":"run_xxx","latest_run_id":"run_xxx","latest_message":"正在执行","updated_at":"2026-07-08T08:12:00Z"},"payload":{"run_id":"run_xxx","task_spec_id":"spec_xxx"}}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `type` | 固定为 `task_status` |
| `event_version` | 当前为 `1` |
| `event_id` | 原始 timeline event id |
| `sse_id` | 和 SSE `id:` 对应的递增序号 |
| `created_at` | 原始事件创建时间；快照事件会使用当前时间 |
| `task_session_id` / `session_id` | TaskSession id；两者当前相同 |
| `event_type` | 原始事件类型，例如 `task_run_started`、`task_run_completed` |
| `task_status` | 任务整体状态，调用方主要看这个字段 |
| `run_status` | 当前或最近一次 TaskRun 状态 |
| `task_spec_status` | 当前 TaskSpec 状态 |
| `confirmation_status` | 当前确认卡状态 |
| `needs_user_action` | 是否需要用户确认、授权或补充信息 |
| `external_run_id` | 外部 worker 或 `/v1/runs` 的 job id，存在时返回 |
| `latest_message` | 任务中心列表可展示的最新摘要 |
| `result_summary` | TaskRun 成功结果摘要 |
| `failure_reason` | TaskRun 失败或取消原因 |
| `task_session` | TaskSession 摘要，用于直接更新调用方本地状态 |
| `payload` | 原始 timeline event 的 payload |

任务进入等待用户动作时，`task_status` 会是 `waiting_user`，并且 `needs_user_action` 为 `true`。如果是确认卡事件，会带上 `confirmation_id` 和 `confirmation_status`：

```text
event: task.status
id: 18
data: {"type":"task_status","event_version":1,"task_session_id":"ts_xxx","event_type":"task_confirmation_requested","task_status":"waiting_user","needs_user_action":true,"confirmation_id":"conf_xxx","confirmation_status":"requested"}
```

终态是 `completed`、`failed`、`cancelled`。默认 `close_on_terminal=true`，到终态后服务端会发送：

```text
data: [DONE]
```

服务端也会发送心跳：

```text
event: heartbeat
data: {"type":"heartbeat","ts":"2026-07-08T08:12:08Z"}
```

调用方应忽略未知 `event:` 和未知字段。SSE 只是通知通道，SQLite 里的 TaskSession / TaskRun 仍是最终状态源；如果连接断开或客户端怀疑漏事件，调用 `GET /v1/task-sessions/:session_id` 做一次状态校准。

### 断线续传

断线重连时，客户端可以把最后收到的 `id:` 放到 `Last-Event-ID` header：

```bash
curl -N "$BASE_URL/task-sessions/$TASK_SESSION_ID/events/stream" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 12"
```

也可以用 query：

```bash
curl -N "$BASE_URL/task-sessions/$TASK_SESSION_ID/events/stream?after_seq=12" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Accept: text/event-stream"
```

常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `from_start` | 没有续传游标时为 `true` | 是否从已有事件开始回放；有 `after_seq` 或 `Last-Event-ID` 时默认从游标后开始 |
| `follow` | `true` | 是否持续等待新事件 |
| `close_on_terminal` | `true` | 任务终态后是否自动关闭流 |
| `heartbeat_seconds` | `8` | 心跳间隔，范围 1 到 60 秒 |
| `after_seq` | 无 | 只推送某个 SSE id 之后的事件 |

如果 `from_start=false` 且没有续传游标，服务端会从当前最新事件之后开始监听，同时先推一条 `task_status` 快照，方便调用方初始化本地状态。

### 客户端处理建议

- 只用 `task_status` 判断任务整体状态，不要把 `run_status` 当成任务状态。
- 收到 `needs_user_action: true` 时，读取 `confirmation_id` 或调用详情接口展示确认卡。
- 收到 `completed`、`failed`、`cancelled` 或 `[DONE]` 后，调用方可以关闭连接。
- 浏览器原生 `EventSource` 不能自定义 `X-API-Key` 和 `X-Ripple-User-Id` header；浏览器直连时应走 trusted proxy，或使用支持自定义 header 的 SSE/fetch 客户端。服务端到服务端对接可以直接用上面的 header。

## 普通 Session 如何对接任务中心

普通 session 是聊天上下文，TaskSession 是任务中心产品对象。两者不要混成一个模型。

### 从聊天创建任务中心记录

1. 客户端调用 `/v1/responses` 进行普通聊天。
2. 从响应 header `x-ripple-session-id` 或 response body `metadata.ripple_session_id` 取到普通 session id。
3. 创建 TaskSession 时写入：

```json
{
  "source_surface": "session",
  "source_id": "srv-xxxx",
  "source_refs": [
    { "type": "session", "id": "srv-xxxx" }
  ]
}
```

示例：

```bash
SESSION_ID="srv-xxxx"

curl -sS "$BASE_URL/task-sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"跟进当前对话里的报价方案\",
    \"source_surface\": \"session\",
    \"source_id\": \"$SESSION_ID\",
    \"task_type\": \"todo\",
    \"goal\": \"把当前对话里的客户需求整理成报价方案\",
    \"executor\": \"vitana\",
    \"task_spec\": {
      \"task_type\": \"todo\",
      \"goal\": \"把当前对话里的客户需求整理成报价方案\",
      \"risk_level\": \"low\",
      \"impact_summary\": \"会读取来源会话内容并生成报价方案草稿。\",
      \"source_refs\": [
        { \"type\": \"session\", \"id\": \"$SESSION_ID\" }
      ]
    }
  }"
```

### 从任务中心打开原聊天

Task center UI 只需要看：

```json
{
  "source_surface": "session",
  "source_id": "srv-xxxx"
}
```

当 `source_surface == "session"` 时，客户端可以用 `source_id` 调用：

```bash
GET /v1/sessions/:session_id
```

或直接在客户端路由中打开对应聊天页。

### 从任务执行回写到普通 session

当前 `/v1/task-sessions` 不会自动把 TaskRun 结果写回普通 session。调用方有两种选择：

- 只把结果写到 TaskRun 的 `result_summary`，任务中心显示即可。
- 如果产品要求普通聊天也看到结果，由业务侧再调用普通 session/chat 相关能力写入消息或发起一次 `/v1/responses` 续接。

## 外部执行器对接建议

如果有独立 worker 执行任务，推荐协议：

1. 前端或业务系统创建 TaskSession 和 TaskSpec。
2. 用户确认 TaskSpec。
3. 业务系统创建 TaskRun，并记录 `external_run_id`。
4. worker 执行真实任务。
5. worker 用 `PATCH /task-sessions/:session_id/runs/:run_id` 回写状态。
6. 调用方订阅 `/task-sessions/:session_id/events/stream` 接收状态变化；详情页也可以读取 `events` 做历史回放。

不要让 worker 写旧 `/v1/tasks`。旧 task/action 是 Ripple 内部执行层，不是产品 API。

## Event Timeline

详情和事件接口都会返回 timeline。事件类型包括但不限于：

```text
task_session_created
task_session_message
task_session_updated
task_spec_drafted
task_spec_updated
task_spec_confirmed
task_run_started
task_run_updated
task_run_waiting_user
task_run_completed
task_run_failed
task_run_cancelled
task_confirmation_requested
task_confirmation_responded
```

客户端应把未知事件当普通文本事件展示，不要因为新增事件类型报错。

## Error Handling

常见状态码：

| HTTP | 场景 |
| --- | --- |
| `400` | payload 格式错误、状态值非法、id 不合法 |
| `401` | API key 或 Bearer token 无效 |
| `404` | TaskSession、TaskSpec、TaskRun 或 Confirmation 不存在 |
| `409` | TaskSpec 尚未确认就启动 TaskRun |

错误响应保留 `detail`，并提供结构化 `error.message`。客户端优先展示 `error.message`。

## Client Checklist

- 列表页调用 `GET /v1/task-sessions`。
- 详情页调用 `GET /v1/task-sessions/:session_id`。
- 创建入口调用 `POST /v1/task-sessions`，必要时内联 `task_spec`。
- 用户确认执行前调用 `POST /task-specs/:task_spec_id/confirm`。
- 执行状态只写 TaskRun，不写旧 task/action。
- 需要用户确认或授权时创建 Confirmation，而不是自定义状态字段。
- 普通 session 关联只用 `source_surface/source_id/source_refs`。
- 不调用 `/v1/tasks`、`/v1/task-triggers` 或旧 action/trigger API。
