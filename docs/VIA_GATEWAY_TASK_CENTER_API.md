# Task Session 接口

## 1. 发送任务消息

```http
POST http://140.143.229.103:8810/v1/task-sessions/responses
Authorization: Bearer <API_KEY>
X-Ripple-User-Id: user_001
Accept: text/event-stream
Content-Type: application/json
```

首轮请求：

```json
{
  "task_id": "task_001",
  "req_id": "req_001",
  "input": "帮我明天下午创建一个项目复盘会",
  "callback_url": "https://your-server.example.com/task-status"
}
```

后续对话保持相同 `task_id`，`req_id` 每轮更新。`callback_url` 首轮保存后可以不再传。

## 2. 确认前的 SSE 回复

信息不足时：

```text
event: response.output_text.delta
data: {"delta":"请补充参会人和会议时间。"}

data: [DONE]
```

信息完整、等待确认时：

```text
event: response.output_text.delta
data: {"delta":"将于明天下午三点创建项目复盘会，是否确认开始执行？"}

data: [DONE]
```

继续补充信息：

```json
{
  "task_id": "task_001",
  "req_id": "req_002",
  "input": "参会人是张三和李四，时间下午三点"
}
```

## 3. 确认执行

```json
{
  "task_id": "task_001",
  "req_id": "req_003",
  "input": "确认开始执行"
}
```

确认后的 SSE 不再返回执行内容，只结束当前连接：

```text
data: [DONE]
```

执行内容和状态改为发送到 `callback_url`。

## 4. Callback 报文

开始执行：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_003",
  "status": "running",
  "content": "任务已开始执行。"
}
```

需要用户授权：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_003",
  "status": "waiting_user",
  "content": "需要完成飞书授权后继续执行。",
  "required_action": {
    "type": "connector_auth",
    "connector": "feishu",
    "auth_url": "https://example.com/auth"
  }
}
```

需要用户确认或补充信息：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_003",
  "status": "waiting_user",
  "content": "请确认是否允许发送消息。",
  "required_action": {
    "type": "confirm",
    "approval": {}
  }
}
```

用户处理后，继续调用同一个接口：

```json
{
  "task_id": "task_001",
  "req_id": "req_004",
  "input": "允许发送"
}
```

执行成功：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_004",
  "status": "completed",
  "content": "项目复盘会议已创建。"
}
```

执行失败：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_004",
  "status": "failed",
  "content": "创建会议失败。",
  "error": {
    "code": "connector_error",
    "message": "飞书接口调用失败。"
  }
}
```

Callback 接收方返回任意 `2xx` 即可，例如：

```json
{
  "ok": true
}
```

Callback 首次失败会立即重试一次，第二次仍失败则停止投递。

## 5. 请求错误

SSE 建立前的 HTTP 错误：

```json
{
  "error": {
    "code": "bad_request",
    "message": "callback_url is required for a new task session"
  },
  "detail": "callback_url is required for a new task session"
}
```

SSE 建立后的对话错误：

```text
event: error
data: {"code":"server_error","message":"Agent run failed"}

data: [DONE]
```
