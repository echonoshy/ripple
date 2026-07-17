# Task Session 接口报文

## 状态类型

| `status` | 返回阶段 |
| --- | --- |
| `running` | 确认执行后，通过 Callback 返回 |
| `waiting_user` | 确认前的 Connector 授权通过 SSE 返回；确认后的授权、确认或补充信息通过 Callback 返回 |
| `completed` | 执行成功后，通过 Callback 返回 |
| `failed` | 执行失败或取消后，通过 Callback 返回 |

## 1. 首次请求

```http
POST /v1/task-sessions/responses
Authorization: Bearer <API_KEY>
X-Ripple-User-Id: user_001
Accept: text/event-stream
Content-Type: application/json
```

```json
{
  "task_id": "task_001",
  "req_id": "req_001",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "帮我明天下午创建一个项目复盘会",
  "callback_url": "https://your-server.example.com/task-status"
}
```

信息不足时的 SSE 回复：

```text
event: response.output_text.delta
data: {"delta":"请补充参会人和会议时间。"}

data: [DONE]
```

## 2. 补充任务信息

```json
{
  "task_id": "task_001",
  "req_id": "req_002",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "参会人是张三和李四，时间下午三点"
}
```

等待确认时的 SSE 回复：

```text
event: response.output_text.delta
data: {"delta":"将于明天下午三点创建项目复盘会，是否确认开始执行？"}

data: [DONE]
```

## 3. 确认执行前需要授权

```json
{
  "task_id": "task_001",
  "req_id": "req_002",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "参会人是张三和李四，时间下午三点"
}
```

SSE 回复：

```text
event: response.output_text.delta
data: {"delta":"需要完成飞书授权后继续执行。"}

event: task.status
data: {"event":"task.status","task_id":"task_001","req_id":"req_002","status":"waiting_user","content":"需要完成飞书授权后继续执行。","required_action":{"type":"connector_auth","connector":"feishu","auth_url":"https://example.com/auth"}}

data: [DONE]
```

完成授权后的请求：

```json
{
  "task_id": "task_001",
  "req_id": "req_003",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "已完成授权"
}
```

等待确认时的 SSE 回复：

```text
event: response.output_text.delta
data: {"delta":"授权已完成。是否确认开始执行？"}

data: [DONE]
```

## 4. 确认执行

```json
{
  "task_id": "task_001",
  "req_id": "req_004",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "确认开始执行"
}
```

SSE 回复：

```text
data: [DONE]
```

`running` Callback：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_004",
  "status": "running",
  "content": "任务已开始执行。"
}
```

Callback 接收方回复：

```json
{
  "ok": true
}
```

## 5. 执行中等待授权

`waiting_user` Callback：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_004",
  "status": "waiting_user",
  "content": "需要完成飞书授权后继续执行。",
  "required_action": {
    "type": "connector_auth",
    "connector": "feishu",
    "auth_url": "https://example.com/auth"
  }
}
```

完成授权后的请求：

```json
{
  "task_id": "task_001",
  "req_id": "req_005",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "已完成授权"
}
```

SSE 回复：

```text
data: [DONE]
```

## 6. 执行中等待确认

`waiting_user` Callback：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_005",
  "status": "waiting_user",
  "content": "请确认是否允许发送消息。",
  "required_action": {
    "type": "confirm",
    "approval": {}
  }
}
```

确认后的请求：

```json
{
  "task_id": "task_001",
  "req_id": "req_006",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "允许发送"
}
```

SSE 回复：

```text
data: [DONE]
```

## 7. 执行中等待补充信息

`waiting_user` Callback：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_006",
  "status": "waiting_user",
  "content": "请补充会议地点。",
  "required_action": {
    "type": "reply",
    "message": "请补充会议地点。"
  }
}
```

补充信息后的请求：

```json
{
  "task_id": "task_001",
  "req_id": "req_007",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "high"
  },
  "input": "会议地点是 3 楼会议室"
}
```

SSE 回复：

```text
data: [DONE]
```

## 8. 执行成功

`completed` Callback：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_007",
  "status": "completed",
  "content": "项目复盘会议已创建。"
}
```

Callback 接收方回复：

```json
{
  "ok": true
}
```

## 9. 执行失败

`failed` Callback：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_007",
  "status": "failed",
  "content": "创建会议失败。",
  "error": {
    "code": "server_error",
    "message": "飞书接口调用失败。"
  }
}
```

Callback 接收方回复：

```json
{
  "ok": true
}
```

## 10. 请求错误

SSE 建立前的 HTTP 错误回复：

```json
{
  "error": {
    "code": "bad_request",
    "message": "callback_url is required for a new task session"
  },
  "detail": "callback_url is required for a new task session"
}
```

SSE 建立后的错误回复：

```text
event: error
data: {"code":"server_error","message":"Agent run failed"}

data: [DONE]
```
