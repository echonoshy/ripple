# Web / Backend Task Contract

本文件给 Linux 后端开发使用。当前 macOS/Web 工作区只保留前端改动；后端实现请在 Linux 环境完成。

## 目标

Web 产品语言统一使用 **Task**，后端第一版可以继续复用现有 **Session** 存储和执行链路。

当前约定：

```text
Task = 用户看到的一件 Codex 工作
Session = 后端保存 messages / approval / context 的技术对象

第一版：task_id == session_id
```

这样前端不再展示 `Session`，但 `/v1/chat/completions` 仍然可以继续接收 `session_id`，避免破坏当前主链路。

## 前端当前依赖

前端已经切到这些 API：

- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/tasks/{task_id}`
- `DELETE /v1/tasks/{task_id}`
- `POST /v1/tasks/{task_id}/stop`
- `POST /v1/tasks/{task_id}/permissions/resolve`

chat 主链路仍使用：

- `POST /v1/chat/completions`

其中请求体继续带 `session_id: task.session_id`。

## 数据结构

### TaskSummary

```json
{
  "task_id": "abc123",
  "session_id": "abc123",
  "title": "Refactor auth flow",
  "model": "codex-medium",
  "created_at": "2026-05-16T09:00:00+00:00",
  "last_active": "2026-05-16T09:05:00+00:00",
  "message_count": 4,
  "status": "running",
  "changed_file_count": 0,
  "pending_approval_count": 0
}
```

Required fields:

- `task_id`: product-facing id. 第一版等于 `session_id`。
- `session_id`: chat completions 继续使用的 id。
- `title`: 任务标题，建议复用现有 session title extraction。
- `model`: 前端下拉能识别的 alias，例如 `codex-medium`。
- `created_at`, `last_active`: ISO 8601 string。
- `message_count`: 当前 session messages 数量。
- `status`: 前端可显示状态，见状态映射。
- `changed_file_count`: 第一版没有 diff/event 聚合时可以返回 `0`。
- `pending_approval_count`: 没有 approval 返回 `0`，有待处理 Codex approval 返回 `1`。

### TaskDetail

`TaskDetail` 继承 `TaskSummary`，额外返回：

```json
{
  "messages": [],
  "pending_question": null,
  "pending_options": null,
  "pending_permission_request": null
}
```

这些字段可以直接复用当前 `SessionDetailResponse` 的序列化逻辑。

## 状态映射

前端希望收到这些产品状态：

```text
idle
queued
running
waiting_for_user
waiting_for_approval
review
completed
failed
cancelled
```

第一版建议映射：

```text
SessionStatus.IDLE                     -> idle
SessionStatus.RUNNING                  -> running
SessionStatus.AWAITING_USER_INPUT      -> waiting_for_user
SessionStatus.AWAITING_PERMISSION      -> waiting_for_approval
suspended / active                     -> idle
error / failed                         -> failed
cancelled / canceled                   -> cancelled
completed                              -> completed
```

如果 `session.pending_permission_request` 非空，应优先返回：

```text
status = waiting_for_approval
pending_approval_count = 1
```

## Endpoint Contract

### GET /v1/tasks

列出当前 `X-Ripple-User-Id` 下的任务。

建议实现：

1. 调用现有 `SessionManager.list_all_sessions(user_id=user_id)`。
2. 过滤规则与 `/v1/sessions` 保持一致。
3. 将 session record 转为 `TaskSummary`。
4. 按 `last_active` 倒序返回。

Response:

```json
{
  "tasks": [],
  "count": 0
}
```

### POST /v1/tasks

创建一个新的 task-backed session。

Request body 第一版可复用 `CreateSessionRequest`：

```json
{
  "model": "codex-medium",
  "max_turns": null,
  "system_prompt": null
}
```

实现要求：

1. 确保当前 user sandbox 存在。
2. 复用 quota check：`assert_can_create_session(...)`。
3. 调用现有 `manager.create_session(...)`。
4. 返回 `TaskSummary`。

### GET /v1/tasks/{task_id}

读取任务详情。

实现要求：

1. 先 `manager.get_session(task_id, user_id=user_id)`。
2. 不在内存时尝试 `manager.resume_session(...)`。
3. 找不到返回 `404 Task not found`。
4. 返回 `TaskDetail`。

### DELETE /v1/tasks/{task_id}

删除任务。第一版直接删除对应 session。

Response:

```json
{
  "ok": true,
  "task_id": "abc123",
  "session_id": "abc123"
}
```

### POST /v1/tasks/{task_id}/stop

停止当前任务正在进行的 Codex chat/run。

第一版可代理现有 session stop：

```json
{
  "ok": true,
  "stopped": true,
  "task_id": "abc123",
  "session_id": "abc123"
}
```

### POST /v1/tasks/{task_id}/permissions/resolve

处理当前 task 的 Codex approval。

Request:

```json
{
  "action": "allow"
}
```

`action` 允许值：

```text
allow
always
deny
```

第一版可直接复用 `/v1/sessions/{session_id}/permissions/resolve` 的逻辑，只是路径换成 task。

## 建议文件改动

后端建议改这些文件：

- `src/interfaces/server/schemas.py`
  - 增加 `TaskInfo`
  - 增加 `TaskDetailResponse`
  - 增加 `TaskListResponse`

- `src/interfaces/server/routes.py`
  - 增加 session status -> task status 映射 helper
  - 增加 session/session record -> task response helper
  - 增加 `/v1/tasks` 相关路由

- `tests/test_task_routes.py`
  - 覆盖 list/detail/create/delete/stop/approval resolve 的基本 contract

## 最小测试建议

在 Linux 后端环境运行：

```bash
uv run pytest tests/test_task_routes.py
uv run pytest tests/test_codex_chat_routes.py tests/test_workspace_routes.py
uv run ruff format .
uv run ruff check .
```

新增测试建议至少覆盖：

1. `GET /v1/tasks` 能把已有 session 映射成 task。
2. `GET /v1/tasks/{task_id}` 返回 messages 和 pending permission。
3. `POST /v1/tasks` 创建 session-backed task。
4. `DELETE /v1/tasks/{task_id}` 删除对应 session。
5. `POST /v1/tasks/{task_id}/stop` 调用 session stop。
6. `POST /v1/tasks/{task_id}/permissions/resolve` 能转发 Codex approval。

## 后续扩展

第一版只做 Task API wrapper。后续要把 Web 的 `Diff / Logs / Checks` 做实，需要继续补：

- 持久化 Codex event stream，并按 task 查询。
- `GET /v1/tasks/{task_id}/events`
- `GET /v1/tasks/{task_id}/diff`
- `GET /v1/tasks/{task_id}/checks`
- changed file count / recent activity / command log 聚合。

这些不要阻塞第一版 Task API。
