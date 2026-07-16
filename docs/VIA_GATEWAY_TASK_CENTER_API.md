# Via-Gateway 任务中心接口（精简版）

本文档定义业务服务端通过 `via-gateway` 调用 Ripple 任务中心的最小可用协议。

主流程：创建任务 → 补充信息 → 确认 → Connector 授权（如需要）→ 自动执行 → Callback。

## 1. 公共约定

### 1.1 Base Path

业务服务端调用：

```text
/via-gateway/v1
```

gateway 转发到 Ripple 时去掉 `/via-gateway` 前缀。

### 1.2 响应包装

成功响应：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

错误响应：

```json
{
  "code": -1,
  "message": "draft_version_conflict",
  "error": {
    "code": "draft_version_conflict",
    "message": "任务草稿已经更新，请刷新后重新确认。",
    "task_id": "task_xxx",
    "req_id": "via-20260716-000123"
  }
}
```

`via-gateway` 负责包装 `code`、`message` 和 `error`；Ripple 返回业务数据和业务错误。HTTP 状态码仍需保留。

### 1.3 用户隔离和 ID

- POST 请求在 body 中传 `user_id`；GET 请求在 query 中传 `user_id`。
- gateway 把 `user_id` 转换为 Ripple 的用户隔离信息，不继续放进 Ripple body。
- `task_id` 贯穿任务完整生命周期。
- `req_id` 在创建时确定，后续命令必须传同一个值。
- `execution_id` 表示一次执行。
- `event_id` 用于 Callback 幂等，`seq` 用于同一任务内排序。

### 1.4 写操作幂等

创建、补充消息、确认、取消都必须传 `idempotency_key`。

- 相同 key、相同请求：返回第一次结果。
- 相同 key、不同请求：HTTP 409，错误码 `idempotency_conflict`。
- `req_id` 不代替 `idempotency_key`。

## 2. TaskSession

TaskSession 是唯一对外任务对象。`TaskSpec` 和 `TaskRun` 仅作为 Ripple 内部存储，不通过 gateway 暴露。

```json
{
  "task_id": "task_xxx",
  "req_id": "via-20260716-000123",
  "title": "发送会议通知",
  "status": "pending_confirmation",
  "phase": "confirmation",
  "waiting_reason": null,
  "needs_user_action": true,
  "draft_version": 2,
  "task_draft": {
    "action": "send_message",
    "connector": "feishu",
    "summary": "通过飞书给张三发送会议通知",
    "parameters": {
      "recipient": {"id": "ou_xxx", "display_name": "张三"},
      "content": "明天下午三点开会"
    },
    "required_connectors": ["feishu"]
  },
  "confirmed_task": null,
  "current_execution": null,
  "required_action": {
    "type": "confirm",
    "message": "任务信息已完整，请确认。",
    "draft_version": 2
  },
  "latest_message": "任务信息已完整，请确认。",
  "created_at": "2026-07-16T10:00:00Z",
  "updated_at": "2026-07-16T10:01:00Z"
}
```

状态：`analyzing`、`waiting_user`、`pending_confirmation`、`queued`、`running`、`completed`、`failed`、`cancelled`。

阶段：`draft`、`confirmation`、`execution`、`terminal`。

当前只支持两种等待原因：`missing_info`、`connector_auth`。

当前只支持三种 `required_action.type`：`reply`、`confirm`、`connector_auth`。

## 3. 接口

### 3.1 创建任务

```http
POST /via-gateway/v1/task-sessions
```

```json
{
  "user_id": "user_001",
  "req_id": "via-20260716-000123",
  "idempotency_key": "create-via-20260716-000123",
  "title": "发送会议通知",
  "content": "用飞书通知张三明天下午三点开会",
  "model": "codex-medium",
  "effort": "medium",
  "callback_url": "https://server.example.com/task-status",
  "context": {"space_id": "space_001", "doc_id": "doc_001"}
}
```

响应 `data.task_session`。信息不足时状态为 `waiting_user`，并返回 `required_action.type = reply`；信息完整时状态为 `pending_confirmation`。

`model`、`effort` 都是可选字段：

- 创建时传入后，作为该 TaskSession 的默认执行配置保存，并在 `data.task_session.model`、`data.task_session.effort` 中回显。
- `model` 可以传真实模型名，也可以传 Ripple 配置中的 preset 名称；Ripple 会像 Chat 接口一样把 preset 解析为真实模型名。
- `effort` 的取值与 Chat 接口一致，例如 `low`、`medium`、`high`；显式传入的 `effort` 优先于 preset 默认值。
- 未传时使用 Ripple 的默认模型及该模型 preset 的默认 effort。

### 3.2 补充或修改任务

```http
POST /via-gateway/v1/task-sessions/{task_id}/messages
```

```json
{
  "user_id": "user_001",
  "req_id": "via-20260716-000123",
  "idempotency_key": "message-via-20260716-000123-1",
  "expected_draft_version": 1,
  "content": "收件人是张三，内容是明天下午三点开会",
  "model": "codex-medium",
  "effort": "high"
}
```

每次有效更新后 `draft_version + 1`。版本不一致时返回 HTTP 409 和 `draft_version_conflict`。

`model`、`effort` 可选，只覆盖本次 TaskSpec 解析，不修改 TaskSession 默认值。

### 3.3 确认并自动执行

```http
POST /via-gateway/v1/task-sessions/{task_id}/confirm
```

```json
{
  "user_id": "user_001",
  "req_id": "via-20260716-000123",
  "idempotency_key": "confirm-via-20260716-000123",
  "draft_version": 2,
  "model": "codex-medium",
  "effort": "high"
}
```

Ripple 冻结当前草稿为 `confirmed_task`，创建 `current_execution`，然后检查 Connector：

- 已授权：直接开始执行。
- 未授权：返回 `waiting_user`、`waiting_reason = connector_auth` 和 `required_action.auth_url`。

授权完成后继续使用同一个 `execution_id`，不再次确认。

`model`、`effort` 可选，只覆盖本次任务执行。执行配置优先级如下：

1. 当前 `confirm` 请求中的 `model`、`effort`。
2. 创建 TaskSession 时保存的默认 `model`、`effort`。
3. Ripple 服务端默认模型及对应 preset 的默认 effort。

如果只覆盖 `model` 而没有传 `effort`，优先使用 TaskSession 默认 effort；TaskSession 也没有默认 effort 时，使用该模型 preset 的默认 effort。

### 3.4 查询任务

```http
GET /via-gateway/v1/task-sessions/{task_id}?user_id=user_001
GET /via-gateway/v1/task-sessions?user_id=user_001&req_id=via-20260716-000123
```

详情响应放在 `data.task_session`；列表响应使用 `data.items` 和 `data.next_cursor`。

### 3.5 取消任务

```http
POST /via-gateway/v1/task-sessions/{task_id}/cancel
```

```json
{
  "user_id": "user_001",
  "req_id": "via-20260716-000123",
  "idempotency_key": "cancel-via-20260716-000123",
  "reason": "cancelled_by_user"
}
```

已取消任务重复取消时返回当前状态。已完成或已失败任务不能取消。

## 4. Callback

```http
POST https://server.example.com/task-status
X-Ripple-Event-Id: evt_xxx
X-Ripple-Task-Id: task_xxx
X-Ripple-Req-Id: via-20260716-000123
```

```json
{
  "event": "task.status",
  "id": 18,
  "data": {
    "event_id": "evt_xxx",
    "seq": 18,
    "event_type": "task_run_completed",
    "task_id": "task_xxx",
    "req_id": "via-20260716-000123",
    "execution_id": "execution_xxx",
    "task_status": "completed",
    "phase": "terminal",
    "waiting_reason": null,
    "needs_user_action": false,
    "required_action": null,
    "action": "send_message",
    "latest_message": "飞书消息已发送给张三。",
    "result_summary": "飞书消息已发送给张三。",
    "result": {"message_id": "om_xxx"},
    "failure_reason": null,
    "created_at": "2026-07-16T10:06:00Z"
  }
}
```

业务服务端必须用 `event_id` 去重，并按 `seq` 更新状态。`task_status` 的位置固定为 `data.task_status`。

## 5. 错误码

| HTTP | error.code | 说明 |
| --- | --- | --- |
| 400 | `bad_request` | 请求字段错误 |
| 404 | `not_found` | 任务不存在或不属于当前用户 |
| 409 | `draft_version_conflict` | 草稿版本冲突 |
| 409 | `idempotency_conflict` | 幂等键复用且请求内容不同 |
| 409 | `req_id_conflict` | req_id 与创建任务时不一致 |
| 409 | `task_not_pending_confirmation` | 当前状态不能确认 |
| 409 | `task_already_terminal` | 终态任务不能取消 |

未列出的扩展字段和交互类型暂不纳入当前版本。
