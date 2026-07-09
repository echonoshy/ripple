# Task Center API Integration Guide

本文面向接入 Vitana/Ripple 任务中心的客户端、gateway 和上游业务系统。任务中心的公开主入口是 `/v1/task-sessions`，不要再调用旧 `/v1/tasks`。

## 结论

- 新任务中心只围绕 `TaskSession`、`TaskSpec`、`TaskRun` 和 `Confirmation` 四类资源对接。
- 普通聊天 session 仍走 `/v1/responses` 和 `/v1/sessions`；如果一个任务来自普通 session，用 `source_surface: "session"` 和 `source_id: "<session_id>"` 把 TaskSession 关联回原会话。
- `/v1/tasks`、`/v1/tasks/:task_id/*` 和 `/v1/task-triggers` 已不再公开注册。
- `GET /v1/sessions/:session_id/tasks` 仅作为 session 兼容只读接口保留，新任务中心不要用它构建主体验。
- gateway 负责选择执行器；只有选择到 Ripple/Vitana 时，才调用本接口进入 Ripple 执行流程。
- 当前 `TaskRun` 是产品层执行投影。gateway 选择 `executor: "ripple"` 或 `"vitana"` 时，Ripple 会启动内部执行器并自动回写 TaskRun 状态。
- 调用方可以传 `callback_url` 或 `callback.url`。Ripple 会把任务状态事件主动 `POST` 给该地址；调用方不需要轮询，也不需要把 SSE 作为主链路。
- `GET /v1/task-sessions/:session_id/events/stream` 仍保留给直接客户端、调试页面和断线校准场景使用。

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
  "callback_url": "https://caller.example.com/task-status",
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

一次执行投影。选择 Ripple/Vitana 执行时，它会映射到 Ripple 内部 Codex/Vitana job。

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
    "callback": {
      "url": "https://caller.example.com/task-status"
    },
    "initial_message": "把会议纪要整理成可执行方案"
  }'
```

响应：

```json
{
  "task_session": {
    "session_id": "ts-xxxx",
    "status": "waiting_user",
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

### 2. 通过对话补齐 TaskSpec

如果调用方只拿到自然语言任务，不需要自己抽取字段。把用户每一轮补充发给 spec-turns：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/spec-turns" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "明天下午三点开会，帮我发个通知",
    "required_fields": ["recipient", "channel", "content"]
  }'
```

后端会：

1. 把用户消息写入 TaskSession timeline。
2. 调用 Agent 判断信息是否足够。
3. 创建或更新 TaskSpec。
4. 如果缺信息，写入 Agent 追问消息，把 TaskSession 投影为 `waiting_user`。
5. 如果信息足够，把 TaskSession 投影为 `pending_confirm`，等待用户确认 TaskSpec。

信息不足时，响应类似：

```json
{
  "task_session": {
    "session_id": "ts-xxxx",
    "status": "waiting_user",
    "needs_user_action": true,
    "latest_message": "还需要补充收件人是谁。"
  },
  "task_spec": {
    "task_spec_id": "spec-xxxx",
    "status": "waiting_user",
    "required_fields": {
      "content": "明天下午三点开会"
    }
  },
  "assistant_message": "还需要补充收件人是谁。",
  "missing_fields": ["recipient"],
  "ready_to_confirm": false,
  "detail": {}
}
```

用户补充后继续调用同一个接口：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/spec-turns" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "发给张三，用飞书"
  }'
```

信息足够时：

```json
{
  "task_session": {
    "status": "pending_confirm",
    "needs_user_action": true
  },
  "task_spec": {
    "task_spec_id": "spec-xxxx",
    "status": "pending_confirm",
    "goal": "给张三发送会议通知",
    "required_fields": {
      "recipient": "张三",
      "channel": "feishu",
      "content": "明天下午三点开会"
    },
    "risk_level": "medium",
    "impact_summary": "确认后会通过飞书给张三发送会议通知。"
  },
  "assistant_message": "TaskSpec 已生成，请确认后开始执行。",
  "missing_fields": [],
  "ready_to_confirm": true
}
```

`spec-turns` 是有 Agent 副作用的接口。只想记录消息时，仍然使用：

```http
POST /v1/task-sessions/:session_id/messages
```

#### Agent 追问写到哪里

Agent 追问用户补充的信息，会写入当前 TaskSession 自己的 timeline，不会自动写回普通 session 的聊天历史。

当调用 `spec-turns` 时，后端会写入两类对话消息：

```json
{
  "event_type": "task_session_message",
  "payload": {
    "role": "user",
    "content": "明天下午三点开会，帮我发个通知"
  }
}
```

```json
{
  "event_type": "task_session_message",
  "payload": {
    "role": "agent",
    "content": "还需要补充收件人是谁。",
    "metadata": {
      "source": "task_spec_turn",
      "ready_to_confirm": false,
      "missing_fields": ["recipient"],
      "task_spec_id": "spec-xxxx",
      "extraction_run_id": "job-xxxx"
    }
  }
}
```

同时还会写入一个状态事件：

```json
{
  "event_type": "task_spec_waiting_user",
  "payload": {
    "task_spec_id": "spec-xxxx",
    "missing_fields": ["recipient"],
    "assistant_message": "还需要补充收件人是谁。"
  }
}
```

调用方读取任务对话历史时，用：

```http
GET /v1/task-sessions/:session_id/events
```

或直接读取任务详情里的 `events`。

普通 session 只通过 `source_surface`、`source_id` 或 `source_refs` 和 TaskSession 建立关联。任务补齐过程里的用户消息、Agent 追问、TaskSpec 状态变化，都以 TaskSession timeline 为准。如果调用方想把追问展示在普通聊天窗口，可以消费 callback、订阅 task SSE，或读取 task events 后自行渲染。

#### 对话补齐到执行的完整流程

完整任务流程如下：

1. 调用方创建 TaskSession。
2. 如果没有传入 `task_spec`，TaskSession 默认进入 `waiting_user`。
3. 用户每补充一句，就调用 `POST /v1/task-sessions/:session_id/spec-turns`。
4. 后端先把用户消息写入 TaskSession timeline。
5. 后端调用 Agent 判断信息是否足够。
6. 信息不足时，Agent 生成追问，后端写入 `task_session_message` 和 `task_spec_waiting_user`，TaskSession 保持 `waiting_user`。
7. 信息足够时，后端生成或更新 TaskSpec，写入 `task_spec_ready_for_confirmation`，TaskSession 进入 `pending_confirm`。
8. 调用方展示 TaskSpec，让用户确认。
9. 用户确认后，调用 `POST /v1/task-sessions/:session_id/task-specs/:task_spec_id/confirm`。
10. 确认后创建 TaskRun 或用 `start_run: true` 同步启动执行。
11. 如果执行器是 Ripple/Vitana，Ripple 内部执行器会执行任务并更新 TaskRun。
12. 调用方通过 callback 或 task SSE 接收 `waiting_user`、`pending_confirm`、`in_progress`、`completed`、`failed`、`cancelled` 等状态变化。

### 3. 列表和详情

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

### 4. 手工创建 TaskSpec

如果调用方不希望后端 Agent 参与，也可以手工创建 TaskSpec：

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

### 5. 用户确认 TaskSpec

只确认，不启动：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs/$TASK_SPEC_ID/confirm" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "start_run": false }'
```

确认并立即创建 TaskRun，但不触发 Ripple 内部执行器：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs/$TASK_SPEC_ID/confirm" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{ "start_run": true }'
```

如果 gateway 已经选择由 Ripple/Vitana 执行，确认时显式传入执行器和 callback：

```bash
curl -sS "$BASE_URL/task-sessions/$TASK_SESSION_ID/task-specs/$TASK_SPEC_ID/confirm" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "start_run": true,
    "executor": "ripple",
    "callback_url": "https://caller.example.com/task-status"
  }'
```

此时 Ripple 会创建 TaskRun、启动内部执行器，并在状态变化时主动回调 `callback_url`。

### 6. 启动 TaskRun

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

如果执行器就是 Ripple/Vitana，传：

```json
{
  "executor": "ripple",
  "auto_execute": true,
  "callback_url": "https://caller.example.com/task-status"
}
```

`executor: "ripple"` / `"vitana"` 或 `auto_execute: true` 会触发 Ripple 内部执行器。执行完成后，Ripple 会把 TaskRun 投影为 `completed` 或 `failed`，并通过 callback/SSE 发出状态事件。

### 7. TaskRun 状态回写

gateway 选择 `executor: "ripple"` / `"vitana"` 后，不需要自己回写 TaskRun。Ripple 内部执行器会在执行完成、失败或等待用户动作时自动更新 TaskRun，并触发 callback。

下面接口主要供内部执行链路、调试工具或迁移脚本使用。

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

状态回写会同步更新 TaskSession 和 TaskSpec 的投影状态，并触发 callback/SSE 状态事件。

### 8. 创建和响应确认卡

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

## Callback 状态回调

调用方希望 Ripple 主动通知任务状态时，在创建 TaskSession、确认 TaskSpec 或启动 TaskRun 时传：

```json
{
  "callback_url": "https://caller.example.com/task-status"
}
```

也可以传：

```json
{
  "callback": {
    "url": "https://caller.example.com/task-status"
  }
}
```

Ripple 会在任务状态事件产生后，向该地址发送：

```http
POST https://caller.example.com/task-status
Content-Type: application/json
```

```json
{
  "event": "task.status",
  "id": 12,
  "data": {
    "type": "task_status",
    "event_version": 1,
    "event_id": "evt_xxx",
    "sse_id": 12,
    "created_at": "2026-07-08T08:12:00Z",
    "task_session_id": "ts_xxx",
    "session_id": "ts_xxx",
    "event_type": "task_run_completed",
    "task_status": "completed",
    "needs_user_action": false,
    "task_spec_id": "spec_xxx",
    "task_spec_status": "completed",
    "run_id": "run_xxx",
    "run_status": "completed",
    "external_run_id": "internal-xxxx",
    "latest_message": "已生成客户方案草稿。",
    "result_summary": "已生成客户方案草稿。",
    "result": {
      "content": "..."
    },
    "failure_reason": null,
    "task_session": {
      "session_id": "ts_xxx",
      "status": "completed",
      "needs_user_action": false
    },
    "payload": {
      "run_id": "run_xxx",
      "status": "completed"
    }
  }
}
```

调用方只需要按 `data.task_status` 更新自己的状态。`event_id` 或 `id` 可以用于幂等处理。

## 直接订阅任务状态 SSE

直接客户端和调试页面可以订阅这个接口。gateway 主链路优先使用 callback，不需要轮询，也不需要监听 SSE：

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
| `external_run_id` | Ripple 内部执行 job id 或其他执行器 job id，存在时返回 |
| `latest_message` | 任务中心列表可展示的最新摘要 |
| `result_summary` | TaskRun 成功结果摘要 |
| `result` | TaskRun 结构化结果或文本结果包装 |
| `failure_reason` | TaskRun 失败或取消原因 |
| `task_session` | TaskSession 摘要，用于直接更新调用方本地状态 |
| `payload` | 原始 timeline event 的 payload |

任务进入等待用户动作时，`task_status` 会是 `waiting_user`，并且 `needs_user_action` 为 `true`。如果是确认卡事件，会带上 `confirmation_id` 和 `confirmation_status`：

```text
event: task.status
id: 18
data: {"type":"task_status","event_version":1,"task_session_id":"ts_xxx","event_type":"task_confirmation_requested","task_status":"waiting_user","needs_user_action":true,"confirmation_id":"conf_xxx","confirmation_status":"requested"}
```

如果是 Agent 追问用户补充 TaskSpec，`event_type` 会是 `task_spec_waiting_user`，追问内容在 `payload.assistant_message`：

```text
event: task.status
id: 19
data: {"type":"task_status","event_version":1,"task_session_id":"ts_xxx","event_type":"task_spec_waiting_user","task_status":"waiting_user","needs_user_action":true,"latest_message":"还需要补充收件人是谁。","payload":{"task_spec_id":"spec_xxx","missing_fields":["recipient"],"assistant_message":"还需要补充收件人是谁。"}}
```

如果 TaskSpec 已经补齐，`event_type` 会是 `task_spec_ready_for_confirmation`，`task_status` 会变成 `pending_confirm`。调用方此时应读取详情里的 `task_specs` 或本次 `spec-turns` 响应里的 `task_spec`，展示给用户确认。

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
- gateway 对接优先消费 callback；SSE 仅作为直接客户端、调试或状态校准通道。

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

## 执行器对接建议

当前 gateway 选择到 Ripple/Vitana 时才需要调用 `/v1/task-sessions` 的执行入口。推荐协议：

1. 前端或业务系统创建 TaskSession 和 TaskSpec。
2. 用户确认 TaskSpec。
3. 确认或启动 TaskRun 时传 `executor: "ripple"` / `"vitana"`，并传 `callback_url` 或 `callback.url`。
4. Ripple 创建 TaskRun，启动内部执行器。
5. Ripple 执行完成后自动回写 TaskRun 状态。
6. 调用方通过 callback 接收状态变化；直接客户端和调试页面也可以订阅 `/task-sessions/:session_id/events/stream` 或读取 `events` 做历史回放。

不要写旧 `/v1/tasks`。旧 task/action 是 Ripple 内部执行层，不是产品 API。

## Event Timeline

详情和事件接口都会返回 timeline。事件类型包括但不限于：

```text
task_session_created
task_session_message
task_session_updated
task_spec_drafted
task_spec_updated
task_spec_waiting_user
task_spec_ready_for_confirmation
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
- 自然语言任务补齐调用 `POST /v1/task-sessions/:session_id/spec-turns`，让 Agent 追问或生成待确认 TaskSpec。
- 用户确认执行前调用 `POST /task-specs/:task_spec_id/confirm`。
- gateway 选择 Ripple/Vitana 执行时，确认或启动 TaskRun 请求里传 `executor: "ripple"` / `"vitana"` 和 `callback_url` / `callback.url`。
- gateway 通过 callback 接收状态；不要轮询 TaskSession，也不要把 SSE 当主链路。
- Ripple 内部执行器自动回写 TaskRun；外部调用方不要写旧 task/action。
- 需要用户确认或授权时创建 Confirmation，而不是自定义状态字段。
- 普通 session 关联只用 `source_surface/source_id/source_refs`。
- 不调用 `/v1/tasks`、`/v1/task-triggers` 或旧 action/trigger API。
