# Deprecated Web / Backend Task Contract

`/v1/tasks` 已废弃并返回 `410 Gone`。Web 产品当前以聊天驱动的工作线程为核心，对外主资源统一为 **Session**。

当前约定：

```text
Session = 用户看到的一条聊天驱动工作线程
Run     = Session 内的一次 Codex 执行，或 /v1/runs 的独立后台执行
Plan    = Codex 当前计划步骤和进度
```

## 替代接口

原 `/v1/tasks` 调用方应迁移到：

```text
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/{session_id}
DELETE /v1/sessions/{session_id}
POST   /v1/sessions/{session_id}/stop
POST   /v1/sessions/{session_id}/context/clear
POST   /v1/sessions/{session_id}/connector-auth/poll
POST   /v1/sessions/{session_id}/permissions/resolve
GET    /v1/sessions/{session_id}/usage
```

`/v1/chat/completions` 继续通过请求体里的 `session_id` 绑定会话。

## Session Summary

`GET /v1/sessions` 返回：

```json
{
  "sessions": [
    {
      "session_id": "srv-abc123",
      "title": "Refactor auth flow",
      "model": "codex-medium",
      "created_at": "2026-05-16T09:00:00+00:00",
      "last_active": "2026-05-16T09:05:00+00:00",
      "message_count": 4,
      "status": "running",
      "changed_file_count": 0,
      "pending_approval_count": 0
    }
  ],
  "count": 1
}
```

状态值使用产品化状态：

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

如果 `pending_permission_request` 非空，优先返回：

```text
status = waiting_for_approval
pending_approval_count = 1
```

## Session Detail

`GET /v1/sessions/{session_id}` 在 summary 字段之外返回：

```json
{
  "messages": [],
  "pending_question": null,
  "pending_options": null,
  "pending_permission_request": null,
  "pending_schedule_request": null,
  "plan_steps": [],
  "plan_progress": null,
  "task_steps": [],
  "task_progress": null
}
```

`plan_steps` / `plan_progress` 是 Codex plan 的主字段；`task_steps` / `task_progress` 暂时保留为旧调用方兼容字段。
