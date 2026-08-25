# Task Sessions：Google Workspace 输入与输出

接口：

```http
POST /v1/task-sessions/responses
Authorization: Bearer <API_KEY>
X-Ripple-User-Id: user_001
Accept: text/event-stream
Content-Type: application/json
```

调用方输入自然语言任务，不直接传 Gmail、Calendar、Drive 等 Google API 参数。

## 1. 输入

### 1.1 请求示例

```json
{
  "task_id": "task_001",
  "req_id": "req_001",
  "input": "帮我在 Google Calendar 创建明天下午三点的项目复盘会议，参会人是 alice@example.com，时长一小时",
  "callback_url": "https://client.example.com/task-status",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "context_folder_path": "/workspace/projects/review"
}
```

### 1.2 请求字段

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `task_id` | 是 | string | 稳定任务 ID。相同用户使用相同 `task_id` 续接任务；最大 256 bytes。 |
| `input` | 是 | string/object/array | 自然语言任务、补充信息、确认文本或授权完成后的继续指令。 |
| `callback_url` | 新任务必填 | string | 接收确认后的任务状态。后续请求可省略，但不能更换。 |
| `req_id` | 否 | string | 本轮追踪 ID，会原样出现在相关状态中；不提供幂等性。 |
| `model` | 否 | string | Ripple 模型 preset 或 Codex runtime 模型 ID。 |
| `reasoning.effort` | 否 | string | 推理强度。 |
| `context_folder_path` | 否 | string/null | 当前轮目录。未传、`null` 或空字符串使用 `/workspace`。 |

`input` 也支持 Responses message 格式：

```json
{
  "input": {
    "role": "user",
    "content": "列出我过去 7 天收到的未读 Gmail 邮件"
  }
}
```

### 1.3 续接输入

补充信息、确认执行或 Google 授权完成后，继续使用相同 `task_id` 调用本接口：

```json
{
  "task_id": "task_001",
  "req_id": "req_002",
  "input": "确认执行"
}
```

```json
{
  "task_id": "task_001",
  "req_id": "req_003",
  "input": "Google Workspace 已授权，请继续执行"
}
```

## 2. 输出

接口始终建立 SSE。确认前的 AI 回复和 Google 授权状态通过 SSE 返回；确认后的任务状态通过 `callback_url` 返回。

### 2.1 SSE：AI 回复

```text
event: response.output_text.delta
data: {"delta":"请补充任务的截止时间和接收人。"}

data: [DONE]
```

一次回复可能包含多条 `response.output_text.delta`，调用方按顺序拼接 `delta`。

### 2.2 SSE：等待 Google 授权

```text
event: response.output_text.delta
data: {"delta":"需要完成 Google Workspace 授权后继续执行。"}

event: task.status
data: {"event":"task.status","task_id":"task_001","req_id":"req_002","status":"waiting_user","content":"需要完成 Google Workspace 授权后继续执行。","required_action":{"type":"connector_auth","connector":"google_workspace","stage":"awaiting_browser_callback","auth_url":"https://accounts.google.com/o/oauth2/auth?...","expires_in_seconds":600}}

data: [DONE]
```

调用方打开本轮 `auth_url`。授权完成后，使用相同 `task_id` 再提交一轮输入。

### 2.3 用户确认后的 SSE

用户确认后，任务转入后台执行，当前 SSE 只返回：

```text
data: [DONE]
```

后续结果从 callback 接收。

### 2.4 Callback：`running`

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_002",
  "status": "running",
  "content": "正在创建项目复盘会议。"
}
```

### 2.5 Callback：`waiting_user`

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_002",
  "status": "waiting_user",
  "content": "需要完成 Google Workspace 授权后继续执行。",
  "required_action": {
    "type": "connector_auth",
    "connector": "google_workspace",
    "stage": "awaiting_browser_callback",
    "auth_url": "https://accounts.google.com/o/oauth2/auth?...",
    "expires_in_seconds": 600
  }
}
```

`required_action.type` 还可能为：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `awaiting_admin_authorization` | `connector` | 等待服务管理员配置 Google Workspace。 |
| `confirm` | `approval` | 等待用户批准 Codex 操作。 |
| `reply` | `message` | 等待用户补充信息。 |

### 2.6 Callback：`completed`

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_002",
  "status": "completed",
  "content": "项目复盘会议已创建，时间为明天下午三点，时长一小时。"
}
```

### 2.7 Callback：`failed`

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_002",
  "status": "failed",
  "content": "创建会议失败。",
  "error": {
    "code": "server_error",
    "message": "创建会议失败。"
  }
}
```

Google 授权失败时：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_002",
  "status": "failed",
  "content": "Google Workspace 授权失败，请重新发起授权。",
  "error": {
    "code": "connector_auth_failed",
    "connector": "google_workspace",
    "stage": "auth_failed",
    "message": "Google Workspace 授权失败，请重新发起授权。"
  }
}
```

### 2.8 Callback：临时进度

```json
{
  "event": "task.status.tmp",
  "task_id": "task_001",
  "req_id": "req_002",
  "status": "running",
  "content": "正在核对会议时间和参会人。"
}
```

`task.status.tmp` 只表示临时进度，不是任务终态。

### 2.9 状态输出字段

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `event` | string | 是 | `task.status` 或临时进度 `task.status.tmp`。 |
| `task_id` | string | 是 | 请求中的任务 ID。 |
| `req_id` | string | 否 | 请求传入非空 `req_id` 时返回。 |
| `status` | string | 是 | `running`、`waiting_user`、`completed`、`failed`。 |
| `content` | JSON value | 是 | 用户可见内容；当前通常为字符串。 |
| `required_action` | object | 否 | `waiting_user` 时的下一步操作。 |
| `error` | object | 否 | `failed` 时的结构化错误。 |

Callback 接收端返回任意 HTTP 2xx 即表示接收成功；失败时 Ripple 会立即重试一次。
