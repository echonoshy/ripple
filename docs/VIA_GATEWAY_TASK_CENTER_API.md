# via-gateway 任务中心接口文档
本文档定义服务端与 `via-gateway` 之间的任务中心接口协议。

约定：

- gateway 对服务端响应统一包一层 `{ "code": 0, "message": "success", "data": ... }`。
- 服务端请求 body 里传 `user_id`，gateway 使用它处理用户上下文，并在调用 Ripple 时转换为 Ripple 需要的用户隔离信息。
- 除上面两点外，任务中心接口的请求字段、返回字段和状态事件按 Ripple 当前 `/v1/task-sessions` 方案透传。
## 1. 公共说明
### 1.1 Base Path
```text
/via-gateway/v1
```
gateway 转发到 Ripple 时，路径去掉 `/via-gateway` 前缀：

```text
/via-gateway/v1/task-sessions -> /v1/task-sessions
```
### 1.2 公共响应结构
gateway 返回给服务端的业务响应统一为：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```
`data` 内部是 Ripple 对应接口的原始返回。
### 1.3 ID 约定
按 Ripple 当前方案：

- `session_id`：TaskSession ID，路径里的 `{session_id}` 指任务会话 ID。
- `task_spec_id`：TaskSpec ID。
- `run_id`：TaskRun ID。

不要把来源 Chat 会话 ID 当作 TaskSession 的 `session_id` 传给任务接口。创建 TaskSession 时通常不传 `session_id`，让 Ripple 自动生成。
### 1.4 状态枚举
TaskSession 状态：

```text
waiting_user
pending_confirm
in_progress
completed
failed
cancelled
```
TaskSpec 状态：

```text
pending_confirm
confirmed
in_progress
waiting_user
completed
failed
cancelled
```
TaskRun 状态：

```text
in_progress
waiting_user
completed
failed
cancelled
```
### 1.5 context 约定
服务端可传：

```json
{
  "context": {
    "space_id": "space_001",
    "doc_id": "doc_001"
  }
}
```
只保留 `context.space_id` 和 `context.doc_id`。gateway 和 Ripple 可把 `context` 当普通扩展对象保存或处理。
## 2. 创建 TaskSession
- Method: `POST`
- Path: `/via-gateway/v1/task-sessions`
### 请求
```json
{
  "user_id": "user_001",
  "req_id": "req_001",
  "title": "吾日三省吾身",
  "task_type": "self_reflection",
  "goal": "生成今日复盘",
  "executor": "vitana",
  "callback_url": "https://server.example.com/task-status",
  "initial_message": "生成今日复盘",
  "context": {
    "space_id": "space_001",
    "doc_id": "doc_001"
  }
}
```
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | 是 | 用户唯一标识，gateway 处理。 |
| `req_id` | string | 是 | 单次请求唯一 ID，用于幂等和排查。 |
| `title` | string | 是 | 任务标题。 |
| `task_type` | string | 是 | 任务类型，如 `self_reflection`、`solution`、`todo`。 |
| `goal` | string | 否 | 用户初始任务目标。 |
| `executor` | string | 否 | 执行器，按 Ripple 字段透传；不传时 Ripple 默认 `vitana`。 |
| `callback_url` | string | 是 | 服务端接收任务状态 callback 的 POST 地址。 |
| `initial_message` | string | 否 | 创建时写入 TaskSession timeline 的用户消息。 |
| `context` | object | 否 | 任务上下文，只保留 `space_id`、`doc_id`。 |

如果已经有结构化 TaskSpec，也可以创建时内联传入 `task_spec`：

```json
{
  "user_id": "user_001",
  "req_id": "req_001",
  "title": "吾日三省吾身",
  "task_type": "self_reflection",
  "goal": "生成今日复盘",
  "callback_url": "https://server.example.com/task-status",
  "task_spec": {
    "task_type": "self_reflection",
    "goal": "生成今日复盘",
    "risk_level": "low",
    "impact_summary": "确认后会生成今日复盘。"
  }
}
```
### 响应
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "title": "吾日三省吾身",
      "task_type": "self_reflection",
      "goal": "生成今日复盘",
      "executor": "vitana",
      "callback_url": "https://server.example.com/task-status",
      "status": "waiting_user",
      "needs_user_action": true,
      "latest_message": "生成今日复盘",
      "current_task_spec_id": null,
      "current_run_id": null,
      "latest_run_id": null,
      "created_at": "2026-07-08T08:00:00Z",
      "updated_at": "2026-07-08T08:00:00Z"
    },
    "task_spec": null
  }
}
```
创建时带 `task_spec` 时，`data.task_spec` 返回创建后的 TaskSpec，TaskSession 通常进入 `pending_confirm`。
## 3. 任务对话补齐或修改 TaskSpec
- Method: `POST`
- Path: `/via-gateway/v1/task-sessions/{session_id}/spec-turns`

`session_id` 是 TaskSession ID。
### 请求
```json
{
  "user_id": "user_001",
  "req_id": "req_002",
  "message": "发给张三，用飞书",
  "context": {
    "space_id": "space_001",
    "doc_id": "doc_001"
  }
}
```
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | 是 | 用户唯一标识，gateway 处理。 |
| `req_id` | string | 是 | 单次请求唯一 ID。 |
| `message` | string | 是 | 用户本轮补充信息或修改 TaskSpec 的自然语言指令。 |
| `context` | object | 否 | 本轮上下文，只保留 `space_id`、`doc_id`。 |
### 响应：信息不足
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "status": "waiting_user",
      "needs_user_action": true,
      "latest_message": "还需要补充收件人是谁。"
    },
    "assistant_message": "还需要补充收件人是谁。",
    "missing_fields": ["recipient"],
    "ready_to_confirm": false
  }
}
```
### 响应：信息足够
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "status": "pending_confirm",
      "needs_user_action": true,
      "latest_message": "TaskSpec 已生成，请确认后开始执行。",
      "current_task_spec_id": "spec_xxx"
    },
    "task_spec": {
      "task_spec_id": "spec_xxx",
      "session_id": "ts_xxx",
      "status": "pending_confirm",
      "task_type": "todo",
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
}
```
服务端以 `ready_to_confirm: true` 作为展示 TaskSpec 并让用户确认的条件。
### 追问补齐机制
追问用户补充信息不是单独接口，而是 `spec-turns` 的返回结果驱动。

当任务信息不足时，Ripple 会把 TaskSession 投影为 `waiting_user`，并返回要展示给用户的问题：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "status": "waiting_user",
      "needs_user_action": true,
      "latest_message": "请补充收件人是谁。"
    },
    "assistant_message": "请补充收件人是谁。",
    "missing_fields": ["recipient"],
    "ready_to_confirm": false
  }
}
```
服务端处理规则：

1. 当 `data.task_session.status == "waiting_user"` 且 `data.ready_to_confirm == false` 时，展示 `data.assistant_message` 给用户。
2. 用户回答后，服务端继续调用同一个 `spec-turns` 接口，把用户回答放到 `message` 字段。
3. 如果仍缺信息，gateway/Ripple 继续返回新的 `assistant_message`、`missing_fields` 和 `ready_to_confirm: false`。
4. 如果信息已经足够，返回 `ready_to_confirm: true`、`status: "pending_confirm"` 和完整 `task_spec`。
5. 服务端此时停止追问，展示 `task_spec` 给用户确认。

示例：用户回答追问后继续补齐。

```http
POST /via-gateway/v1/task-sessions/ts_xxx/spec-turns
Content-Type: application/json
```
```json
{
  "user_id": "user_001",
  "req_id": "req_003",
  "message": "发给张三，用飞书"
}
```
如果还缺内容，继续返回：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "status": "waiting_user",
      "needs_user_action": true,
      "latest_message": "请补充要发送的具体通知内容。"
    },
    "assistant_message": "请补充要发送的具体通知内容。",
    "missing_fields": ["content"],
    "ready_to_confirm": false
  }
}
```
用户继续回答：

```json
{
  "user_id": "user_001",
  "req_id": "req_004",
  "message": "明天下午三点开会，请准时参加。"
}
```
信息足够后返回：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "status": "pending_confirm",
      "needs_user_action": true,
      "current_task_spec_id": "spec_xxx",
      "latest_message": "TaskSpec 已生成，请确认后开始执行。"
    },
    "task_spec": {
      "task_spec_id": "spec_xxx",
      "session_id": "ts_xxx",
      "status": "pending_confirm",
      "goal": "给张三发送会议通知",
      "required_fields": {
        "recipient": "张三",
        "channel": "feishu",
        "content": "明天下午三点开会，请准时参加。"
      },
      "risk_level": "medium",
      "impact_summary": "确认后会通过飞书给张三发送会议通知。"
    },
    "assistant_message": "TaskSpec 已生成，请确认后开始执行。",
    "missing_fields": [],
    "ready_to_confirm": true
  }
}
```
字段含义：

| 字段 | 说明 |
| --- | --- |
| `assistant_message` | 服务端展示给用户的问题或提示。 |
| `missing_fields` | 当前仍缺失的字段列表。 |
| `ready_to_confirm` | 是否已可展示 TaskSpec 并进入用户确认。 |
| `task_session.latest_message` | 任务列表或会话摘要可展示的最新文案。 |
| `task_spec` | `ready_to_confirm: true` 时需要展示给用户确认的 TaskSpec。 |

服务端不需要自己推断缺哪些字段，以 `assistant_message` 和 `ready_to_confirm` 驱动交互即可。
## 4. 用户确认并执行任务
- Method: `POST`
- Path: `/via-gateway/v1/task-sessions/{session_id}/task-specs/{task_spec_id}/confirm`

`session_id` 是 TaskSession ID。
### 请求
```json
{
  "user_id": "user_001",
  "req_id": "req_003",
  "start_run": true,
  "executor": "vitana"
}
```
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | 是 | 用户唯一标识，gateway 处理。 |
| `req_id` | string | 是 | 单次请求唯一 ID。 |
| `start_run` | boolean | 是 | 确认后是否创建 TaskRun。确认并执行时传 `true`。 |
| `executor` | string | 否 | 执行器。传 `ripple`、`vitana` 或 `ripple_vitana` 会触发 Ripple 内部执行器。 |
| `auto_execute` | boolean | 否 | 传 `true` 也会触发 Ripple 内部执行器。 |
| `callback_url` | string | 否 | 本次执行的状态回调地址；不传则继续使用创建 TaskSession 时保存的地址。 |

说明：

- 只确认、不创建 TaskRun 时，可传 `start_run: false`。
- 确认并执行时，必须传 `start_run: true`。
- 如果要启动 Ripple 内部执行器，需要传 `executor: "ripple"` / `"vitana"` / `"ripple_vitana"`，或传 `auto_execute: true`。
### 响应
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_session": {
      "session_id": "ts_xxx",
      "status": "in_progress",
      "needs_user_action": false,
      "current_task_spec_id": "spec_xxx",
      "current_run_id": "run_xxx",
      "latest_run_id": "run_xxx"
    },
    "task_spec": {
      "task_spec_id": "spec_xxx",
      "session_id": "ts_xxx",
      "status": "in_progress",
      "confirmed_at": "2026-07-08T08:10:00Z"
    },
    "run": {
      "run_id": "run_xxx",
      "session_id": "ts_xxx",
      "task_spec_id": "spec_xxx",
      "status": "in_progress",
      "executor": "vitana",
      "callback_url": "https://server.example.com/task-status",
      "started_at": "2026-07-08T08:10:00Z"
    }
  }
}
```
`start_run: false` 时，`data.run` 为 `null`。
## 5. 任务状态 callback
任务状态 callback 是任务状态变化后向服务端提供的 `callback_url` 发送的 HTTP POST。
### 请求
```http
POST https://server.example.com/task-status
Content-Type: application/json
```
callback payload 按 Ripple 当前 `task.status` 格式：

```json
{
  "event": "task.status",
  "id": 15,
  "data": {
    "event_id": "evt_xxx",
    "task_session_id": "ts_xxx",
    "task_status": "completed",
    "needs_user_action": false,
    "task_spec_id": "spec_xxx",
    "run_id": "run_xxx",
    "latest_message": "任务已完成。",
    "result_summary": "已生成今日复盘。",
    "result": {
      "content": "..."
    },
    "failure_reason": null
  }
}
```
### 字段说明
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `event` | string | 固定为 `task.status`。 |
| `id` | integer/string/null | 事件序号，可用于幂等或排序。 |
| `data.event_id` | string | 事件 ID，可用于幂等。 |
| `data.task_session_id` | string | TaskSession ID。 |
| `data.task_status` | string | 任务整体状态。服务端主要看该字段。 |
| `data.needs_user_action` | boolean | 是否需要用户补充、确认或授权。 |
| `data.task_spec_id` | string/null | 相关 TaskSpec ID。 |
| `data.run_id` | string/null | 相关 TaskRun ID。 |
| `data.latest_message` | string | 可展示给用户的最新文案。 |
| `data.result_summary` | string | 任务完成摘要。 |
| `data.result` | object/null | 任务完成结果。 |
| `data.failure_reason` | string | 失败或取消原因。 |
服务端主流程只依赖上面这些字段。Ripple callback 可能额外带 `type`、`event_version`、`sse_id`、`created_at`、`session_id`、`event_type`、`task_spec_status`、`run_status`、`external_run_id`、`confirmation_id`、`confirmation_status`、`task_session`、`payload` 等字段；服务端可以忽略。
### callback 约束
- 服务端返回 HTTP `2xx` 表示接收成功。
- 服务端应使用 `data.event_id` 或顶层 `id` 做幂等处理。
- 服务端只用 `data.task_status` 判断任务整体状态。
- 终态为 `completed`、`failed`、`cancelled`。
- 服务端应忽略未知字段。
## 6. 错误处理
gateway 可继续用统一结构返回错误：

```json
{
  "code": 40001,
  "message": "task_spec_confirmation_required",
  "data": {
    "detail": {
      "code": "task_spec_confirmation_required",
      "message": "TaskSpec must be confirmed before it can run.",
      "task_spec_id": "spec_xxx"
    }
  }
}
```
常见 HTTP 状态码：

| HTTP | 场景 |
| --- | --- |
| `400` | 请求参数错误。 |
| `401` | 调用方身份无效。 |
| `404` | TaskSession、TaskSpec 或 TaskRun 不存在。 |
| `409` | 当前任务状态不允许该操作。 |
| `500` | gateway 或能力侧内部错误。 |
## 7. 服务端接入清单
- 创建任务调用 `POST /via-gateway/v1/task-sessions`。
- 创建时保存 `data.task_session.session_id`，后续路径使用该 ID。
- 不把来源 Chat 会话 ID 当作 TaskSession `session_id` 传入。
- 用户每次补充信息时调用 `spec-turns`。
- `ready_to_confirm: true` 后展示 TaskSpec 给用户确认。
- 用户确认并执行时调用 confirm，传 `start_run: true`。
- 需要 Ripple 内部执行时，传 `executor` 或 `auto_execute: true`。
- 通过 callback 接收任务状态。
- 只用 callback 的 `data.task_status` 判断任务整体状态。
- 用 `data.event_id` 或顶层 `id` 做幂等。
- 忽略未知字段。
