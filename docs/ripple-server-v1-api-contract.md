# Ripple Server v1 API Contract

本契约描述 `ripple-server` 当前的单机自托管 `/v1` API 约定。目标是兼容现有客户端，同时把新增成熟化字段做成非破坏式扩展。

## Auth

- 受保护路由使用 `Authorization: Bearer <server_api_key>` 或 `X-API-Key`。
- `X-Ripple-User-Id` 是用户隔离入口，合法字符为 `[a-zA-Z0-9_-]{1,64}`。
- 生产推荐 `trusted-proxy`：普通浏览器不直接持有 server API key；上游认证后注入 `X-Ripple-User-Id`，并剥离客户端伪造 header。
- 如果启用 `server.user_auth.enabled`，浏览器用户也可通过邀请制账号登录获取 Bearer session token。此时后端使用 token 绑定的 `user_id`，并忽略客户端传入的 `X-Ripple-User-Id`。

轻量用户体系公开入口：

- `GET /v1/auth/config`
- `POST /v1/auth/invite/claim`
- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `POST /v1/auth/password`

管理员通过 CLI 管理邀请码和用户：`ripple-server auth create-invite`、`list-users`、`disable-user`、`revoke-sessions`。

## Generated API Docs

- `GET /openapi.json` 返回由 Rust handler annotation 和 schema derive 生成的 OpenAPI spec。
- `GET /docs` 提供 Swagger UI，默认读取 `/openapi.json`。
- `server.api_docs.enabled` 可关闭文档入口；`server.api_docs.try_it_out_enabled` 控制 Swagger UI 是否默认展开 Try it out。
- 文档入口不包含 API key，受保护 `/v1` API 的鉴权行为不变。
- `/docs` 随当前 Rust 路由和 `#[utoipa::path]` annotation 在构建时生成；服务启动后会展示最新 `/openapi.json`，不维护手写静态 Swagger 文件。
- 当前 `/docs` 覆盖 `api/mod.rs` 注册的公开和受保护接口，包括 auth、health、models/info、chat、sessions、tasks/task triggers、runs、users、sandboxes、workspace、documents、capabilities、skills 和 connector 管理接口。仍返回 `Json<Value>` 的响应会先以宽松 JSON schema 表达，后续类型化 response struct 后 schema 会进一步自动同步。
- 新增后端接口时，应使用 `utoipa_axum::routes!(...)` 注册并补 `#[utoipa::path]` annotation；普通 `.route(...)` 只会注册服务路由，不会自动进入 OpenAPI。`api_smoke` 中的 OpenAPI 覆盖测试会校验当前主接口清单是否出现在 `/openapi.json`。

## Errors

新错误响应保留旧 `detail` 字段，并新增结构化 `error`：

```json
{
  "detail": "Invalid or missing API key",
  "error": {
    "code": "unauthorized",
    "message": "Invalid or missing API key",
    "request_id": "req-...",
    "details": "Invalid or missing API key"
  }
}
```

客户端应优先读 `error.message`，旧客户端可继续读 `detail`。

## Pagination

列表接口开始支持 `limit` 和 `cursor`。Sessions、runs 和 task triggers 返回 `count`、`total`、`next_cursor`；tasks 为兼容当前客户端 response shape，返回 `count` 和 `next_cursor`，其中 `count` 是分页前当前 user 匹配的 task 数量：

- `GET /v1/sessions?limit=50&cursor=50`
- `GET /v1/runs?limit=50&cursor=50`
- `GET /v1/tasks/:task_id/triggers?limit=50&cursor=50`
- `GET /v1/tasks?limit=50&cursor=50`

`cursor` 当前是稳定的 offset 字符串，客户端应只把它当 opaque token 传回。

## Chat And Sessions

- `POST /v1/responses` 是唯一 chat 入口。它是 Ripple 控制面提供的 Responses-style subset / façade，不是完整 OpenAI Responses API 代理；模型厂商兼容和完整 Responses 能力由服务端 Codex app-server 配置承接。
- 请求支持 `input`、`instructions`、`stream`、`previous_response_id`、`metadata.ripple_session_id`、`store`、`reasoning.effort`、`reasoning.summary` 和 `text.format.json_schema` 等当前 chat 链路需要的字段；其它 Responses 字段可能被忽略，调用方不要依赖完整 OpenAI Responses 字段透传。
- `input` 可为字符串、单个 message object 或 message object 数组。聊天执行以最后一个 user message 作为本轮用户输入；`instructions` 会作为 caller system prompt 注入。
- 可用 `previous_response_id=resp_<session_id>` 或 `metadata.ripple_session_id` 续接已有 Ripple session；未传 session id 时由 Ripple 自动生成。
- `/v1/responses` 返回 `object=response`、`output`、`output_text` 和 `metadata.ripple_session_id`；流式响应使用 `response.created`、`response.output_text.delta`、`response.completed`，Ripple 控制面事件以 `ripple.*` 扩展事件发送。需要 approval 或用户输入等等待态时，也会先发送对应 `ripple.*` 事件，再发送 terminal `response.completed` 和 `[DONE]`。
- 响应继续返回 `x-ripple-session-id` header，调用方可用它确认最终使用的内部 session。
- 调用方通过 `metadata.ripple_session_id` 或 `previous_response_id=resp_<session_id>` 传入的 session id 必须匹配 `[a-zA-Z0-9_-]{1,64}`。这是为了保证 session runtime 目录和 SQLite 主键都安全可控。
- `/v1/chat/completions` 不再注册；客户端和外部调用方必须使用 `/v1/responses`。

### External Chat Caller Contract

外部业务系统可以按下面的最小协议接入 chat。

公共 header：

```http
Authorization: Bearer <RIPPLE_SERVER_API_KEY>
X-Ripple-User-Id: <user_id>
Content-Type: application/json
```

如果使用 `server.user_auth.enabled` 登录态 token，后端会以 token 绑定的 user 为准，忽略客户端伪造的 `X-Ripple-User-Id`。

#### 1. Session 是否必须创建

不必须。调用方可以直接请求 `/v1/responses`。

未传 session id 时，Ripple 会自动创建 session。调用方应从 response body 的 `metadata.ripple_session_id` 或 response header `x-ripple-session-id` 读取最终 session id，后续用它续聊。

也可以不提前调用 `POST /v1/sessions`，直接在 `/v1/responses` 中传一个自定义 session id。如果该 session 不存在，Ripple 会自动用这个 id 创建；如果已存在，则续接该 session。

```json
{
  "model": "codex-high",
  "stream": true,
  "input": "你好，帮我分析 /workspace/docs。",
  "metadata": {
    "ripple_session_id": "my_session_001"
  }
}
```

下一轮继续传同一个 session：

```json
{
  "model": "codex-high",
  "stream": true,
  "previous_response_id": "resp_my_session_001",
  "input": "继续刚才的分析，列出风险点。",
  "metadata": {
    "ripple_session_id": "my_session_001"
  }
}
```

推荐同时传 `previous_response_id=resp_<session_id>` 和 `metadata.ripple_session_id`。仅传 `previous_response_id` 也可以解析出 session id，但显式 metadata 更清晰。

#### 2. 什么时候需要先创建 Session

如果调用方要在执行前设置 session 级属性，例如选定默认模型、`context_folder_path`、`system_prompt` 或 `max_turns`，应先调用 `POST /v1/sessions`。

```json
{
  "model": "codex-high",
  "context_folder_path": "/workspace/docs",
  "max_turns": 200,
  "system_prompt": "你是一个严谨的文档分析助手。"
}
```

返回中的 `session_id` 用于后续 `/v1/responses`：

```json
{
  "session_id": "srv_abc123",
  "context_folder_path": "/workspace/docs",
  "model": "codex-high",
  "status": "idle"
}
```

已有 session 可通过 `PATCH /v1/sessions/{session_id}` 更新模型或 focus 目录：

```json
{
  "model": "codex-medium",
  "context_folder_path": "/workspace/reports"
}
```

清空 focus 目录：

```json
{
  "context_folder_path": null
}
```

#### 3. `context_folder_path`

`context_folder_path` 是 session 级字段，只在 `POST /v1/sessions` 或 `PATCH /v1/sessions/{session_id}` 中传，不是 `/v1/responses.metadata` 字段。

当前只支持一个目录，不支持 list：

```json
{
  "context_folder_path": "/workspace/docs"
}
```

不支持：

```json
{
  "context_folder_path": [
    "/workspace/docs",
    "/workspace/reports"
  ]
}
```

后端会校验该路径必须是当前 user workspace 下已存在的目录。设置后，后续同一 session 的 chat 会自动把它作为默认 reading/search scope，并把 Codex run 的 cwd 设置为该目录。传 `/workspace` 等价于清空 focus，表示全 workspace。

多个目录的当前写法：选一个主目录作为 `context_folder_path`，其它目录放入用户文本或 `metadata.client_context`。

```json
{
  "model": "codex-high",
  "stream": true,
  "previous_response_id": "resp_srv_abc123",
  "input": "请以 /workspace/docs 为主，同时参考 /workspace/reports 和 /workspace/data。",
  "metadata": {
    "ripple_session_id": "srv_abc123",
    "client_context": {
      "software": {
        "selection": {
          "focus_folder_path": "/workspace/docs",
          "additional_folder_paths": [
            "/workspace/reports",
            "/workspace/data"
          ]
        }
      }
    }
  }
}
```

#### 4. 完整 Chat 请求示例

```json
{
  "model": "codex-high",
  "stream": true,
  "previous_response_id": "resp_srv_abc123",
  "instructions": "本轮回答要先说明读取了哪些文件，再给结论。",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请分析 /workspace/docs 和 /workspace/reports 两个目录，并重点参考下面这个文件。"
        },
        {
          "type": "file",
          "file": {
            "path": "/workspace/docs/key_report.pdf",
            "name": "key_report.pdf",
            "mime_type": "application/pdf"
          }
        }
      ]
    }
  ],
  "store": true,
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "metadata": {
    "ripple_session_id": "srv_abc123",
    "required_skill_ids": [],
    "screen_context": {
      "app": "ripple",
      "screen_id": "session.chat",
      "active_view": "chat"
    },
    "client_context": {
      "schema_version": "ripple.client_context.v1",
      "software": {
        "selection": {
          "focus_folder_path": "/workspace/docs",
          "additional_folder_paths": [
            "/workspace/reports",
            "/workspace/data"
          ],
          "file_paths": [
            "/workspace/docs/key_report.pdf"
          ]
        }
      }
    }
  }
}
```

文件必须先进入当前 user 的 Ripple workspace，再通过 `/workspace/...` 虚拟路径传给 chat。文件 block 格式：

```json
{
  "type": "file",
  "file": {
    "path": "/workspace/docs/a.md",
    "name": "a.md",
    "mime_type": "text/markdown"
  }
}
```

目录没有单独的 `type: "folder"` block；目录路径应写入用户文本，或作为辅助信息放进 `metadata.client_context`。

#### 5. 输出位置

非流式请求读取 `output_text`：

```json
{
  "id": "resp_srv_abc123",
  "object": "response",
  "status": "completed",
  "model": "codex-high",
  "output_text": "完整回答",
  "metadata": {
    "ripple_session_id": "srv_abc123"
  }
}
```

流式请求使用 SSE。客户端应拼接所有 `response.output_text.delta.delta`，并用 `response.completed.response.output_text` 校验最终完整文本。

开始事件：

```json
{
  "type": "response.created",
  "response": {
    "id": "resp_srv_abc123",
    "status": "in_progress",
    "model": "codex-high",
    "metadata": {
      "ripple_session_id": "srv_abc123"
    }
  }
}
```

增量文本：

```json
{
  "type": "response.output_text.delta",
  "response_id": "resp_srv_abc123",
  "delta": "这里是一段输出"
}
```

完成事件：

```json
{
  "type": "response.completed",
  "response": {
    "id": "resp_srv_abc123",
    "status": "completed",
    "output_text": "完整回答",
    "metadata": {
      "ripple_session_id": "srv_abc123"
    }
  }
}
```

SSE 最后发送：

```text
[DONE]
```

#### 6. ask_user / user input

当前有两类用户补充输入。

控制面 `ask_user` 会通过 SSE 发送 `agent_stop`：

```json
{
  "type": "agent_stop",
  "stop_reason": "ask_user",
  "metadata": {
    "message": "需要你确认范围。",
    "question": "要分析哪个目录？",
    "options": [
      "/workspace/docs",
      "/workspace/reports"
    ]
  }
}
```

这种情况下一轮继续调用 `/v1/responses`，带同一个 session id：

```json
{
  "model": "codex-high",
  "stream": true,
  "previous_response_id": "resp_srv_abc123",
  "input": "选择 /workspace/docs",
  "metadata": {
    "ripple_session_id": "srv_abc123"
  }
}
```

Codex 原生 `requestUserInput` 等待态会通过 SSE 发送 `user_input_required`：

```json
{
  "type": "user_input_required",
  "user_input": {
    "request_id": "req_123",
    "questions": [
      {
        "id": "target_folder",
        "question": "要分析哪个文件夹？"
      }
    ]
  }
}
```

这种情况调用 `POST /v1/sessions/{session_id}/user-input/resolve`。

简单写法：

```json
{
  "answer": "/workspace/docs"
}
```

结构化写法：

```json
{
  "request_id": "req_123",
  "answers": {
    "target_folder": {
      "answers": [
        "/workspace/docs"
      ]
    }
  }
}
```

#### 7. ask_permission / approval

需要审批时，SSE 会发送 `approval_required`：

```json
{
  "type": "approval_required",
  "approval": {
    "job_id": "job_123",
    "request_id": "req_456",
    "tool": "shell_command",
    "params": {
      "cmd": "python analyze.py"
    }
  }
}
```

调用 `POST /v1/sessions/{session_id}/permissions/resolve` 继续或拒绝。

同意：

```json
{
  "action": "allow"
}
```

永远同意同类请求：

```json
{
  "action": "always"
}
```

拒绝：

```json
{
  "action": "deny"
}
```

也可以显式带 `job_id` 和 `request_id`：

```json
{
  "action": "allow",
  "job_id": "job_123",
  "request_id": "req_456"
}
```

resolve 接口返回 `{ ok, session_id, job_id, action }`，不是新的 SSE 流。后端会继续原 job；调用方可随后刷新 `GET /v1/sessions/{session_id}` 获取最终状态和消息。

#### 8. 查询 Session

`GET /v1/sessions/{session_id}` 返回 session 状态、历史消息、等待态信息和 plan/task progress。调用方可用它恢复页面状态。

```json
{
  "session_id": "srv_abc123",
  "status": "waiting_for_user",
  "context_folder_path": "/workspace/docs",
  "model": "codex-high",
  "messages": [],
  "pending_question": "要分析哪个文件夹？",
  "pending_options": [
    "/workspace/docs",
    "/workspace/reports"
  ],
  "pending_permission_request": null
}
```

## Runs

- `GET /v1/runs/:job_id/events` 返回 SSE，每个 JSON event 带 `event_version: 1`。
- `GET /v1/runs/:job_id/output` 下载 run output，不要求客户端读取 host path。
- `events_file` 和 `output_file` 仍保留给管理员调试，客户端不要依赖它们作为下载入口。
- 服务重启时遗留 `queued/running` run 会标记为 `failed`，`failure_reason=interrupted_by_restart`。

## Tasks

Tasks 是当前持久 follow-up 和多步工作状态的主 API，不是旧兼容占位接口。

- `GET /v1/tasks` 列出当前 user 的 tasks；`POST /v1/tasks` 创建 task 和可选 actions。
- `GET /v1/tasks/:task_id` 返回 task、actions 和 progress；`PATCH /v1/tasks/:task_id` 更新 task。
- `DELETE /v1/tasks/:task_id` 将 task 标记为 cancelled；`POST /v1/tasks/:task_id/delete` 物理删除 task、actions 和 events。
- `POST /v1/tasks/:task_id/confirm` 将 candidate task/action 确认为可执行状态。
- `POST /v1/tasks/:task_id/run-now` 从 task 的 `source_session_id` 构建一次 Codex run，并把进展写回 task events/actions。
- `GET /v1/tasks/:task_id/actions`、`POST /v1/tasks/:task_id/actions`、`PATCH /v1/tasks/:task_id/actions/:action_id` 管理 task actions。
- `GET /v1/tasks/:task_id/triggers` 返回 task-scoped triggers。TaskTrigger 通过 `trigger_type` 区分 driver；当前唯一已启用 driver 是 `time`，使用 `task_triggers` 存储，并在 response 中提供 `trigger_id` / `trigger_type`。
- `POST /v1/tasks/:task_id/actions/:action_id/triggers` 为指定 action 创建 future/recurring trigger。
- `PATCH /v1/tasks/:task_id/triggers/:trigger_id` 更新 time trigger 配置，包括 `kind`、`run_at`、`interval_seconds`、`max_runs`、`enabled`、policy、model 和 cwd 等字段。暂停会清空 `next_run_at`；恢复或修改时间配置会重新计算下一次执行时间。
- `DELETE /v1/tasks/:task_id/triggers/:trigger_id` 删除指定 task-linked trigger。
- `POST /v1/tasks/:task_id/triggers/:trigger_id/run-now` 立即触发 task-linked trigger。
- `GET /v1/tasks/:task_id/events` 返回 task timeline。
- `GET /v1/sessions/:session_id/tasks` 返回与 session 关联的 tasks。

Chat 主链路会向 Codex 暴露 `codex_app.task_update` 动态工具。它只写 Ripple 控制面 task/action 状态，不要求 Codex 反向调用 Ripple HTTP API。支持 `propose`、`create`、`update_task`、`create_action`、`update_action`、`start_action`、`complete_action`、`block_action`、`wait_user` 和 `complete_task` 等模式。`wait_user` 会把 `reason`、`clarification_question` 和 `missing_fields` 持久化到 action，并产生 `task_action_waiting_user` event；`complete_task` 会写入 `result_summary` 和 `completed_at`。

Task 是唯一任务语义。旧 standalone schedule API 和 `schedules` 表已移除；time trigger 统一作为 Task Trigger 的一种 driver 存在。Task-linked trigger 到期时会走 TaskAction 执行链路，复用原 session/Codex thread，并把结果写回 task events/actions 和 source session。后续 hook/event/webhook 类触发器也应挂在同一 task trigger 模型下。

## Risk Confirmation

高风险后端 API 要求 JSON body 带 `confirm: true`，并写入 `.ripple/audit.jsonl`：

- `DELETE /v1/sandboxes`
- `POST /v1/workspace/delete`
- `POST /v1/connectors/:connector_name/disconnect`
- `DELETE /v1/skills/:skill_id`

缺少确认时返回 `428 confirmation_required`。

## Connector Management

`GET /v1/connectors` 返回每个 connector 的可用管理入口。`user_connector` 会暴露 web/chat 授权能力、`auth_start_path`、可选 `auth_complete_path`、`auth_cancel_path`、`disconnect_path`、`accounts_path` 和能力标记；`runtime_capability` 不暴露 per-user 授权或断开入口。

- `POST /v1/connectors/:connector_name/auth/cancel` 取消当前 user 的待授权状态，幂等返回 `{ ok, connector, cancelled }`。它会清理 connector runtime pending state，例如 Google assisted OAuth、Feishu setup 进程、Bilibili QR pending state，并清掉该 user 相关 session 的 pending connector auth。
- `POST /v1/connectors/:connector_name/disconnect` 是本地断开。它删除 Ripple user sandbox 里的 token、keyring、cookie 或 CLI 配置，不承诺撤销 provider 侧授权。Google 支持 `{ email }` 删除单个本地账号 token，也支持 `{ all: true }` 清理本地 Google keyring。
- `GET /v1/capabilities` 返回内部统一能力目录，合并 connectors、runtime capabilities、Ripple shared skills 和当前 user workspace skills；前端普通用户页面不直接展示 runtime capability 分类。runtime capability 条目会带 `runtime` 元数据，例如 Codex app-server stdio protocol、managed permission profile、workspace messages 方法，以及 image input 只接受 workspace/local/inline data image、拒绝远程 HTTP(S) URL 的策略。
- `GET /v1/skills` 返回用户侧 skill 列表，不包含 runtime capability；skill 条目包含 `display_source`、`kind`、`runtime`、`entry`、`python_packages`、`content_hash` 和 `last_validated_at`。
- `POST /v1/skills` 创建当前 user 的 skill；旧 text skill 字段保持兼容，新增字段支持创建 Python executable skill。创建后会立即校验，安全且通过时自动启用。
- `GET /v1/skills/:skill_id` 返回单个 skill 详情。
- `PATCH /v1/skills/:skill_id` 支持编辑、启用和停用 `user:*` skill；内容编辑会立即重新校验，`ripple:*` shared skills 只读。
- `DELETE /v1/skills/:skill_id` 需要 `{ confirm: true }`，归档 user skill，不物理丢失。
- `POST /v1/skills/:skill_id/validate` 执行格式、安全、当前依赖可用性、Python runtime 和 content-hash 校验；不会运行用户脚本或安装 Python 包。安全 skill 校验通过后自动注入 Codex prompt；需要显式确认或带 risk flags 的 skill 需要用户手动启用。

## Health And Diagnostics

- `GET /health`：公开活性检查。
- `GET /v1/health/ready`：就绪检查，覆盖 SQLite、sandbox 目录、Codex executable。
- `GET /v1/diagnostics/doctor`：管理员诊断，覆盖安全姿态、CORS、SQLite、目录、Codex executable、Codex app-server protocol/permission profile、bwrap/Codex Linux sandbox probe、nsjail config/runtime probe、connector CLI 和 backup contract。

CLI 同步提供：

```bash
cargo run -p ripple-server -- doctor --config config/settings.yaml
```

## Sandbox Info

`GET /v1/sandbox/info` 明确区分：

- Codex app-server：服务端受信宿主进程。
- Codex shell commands：Codex Linux sandbox/bubblewrap + Ripple managed permissions profile，启动前 probe 失败则 fail closed。
- Connector CLI：nsjail runtime，要求 new pid/ipc/uts/user namespace、fresh `/proc`、共享 network namespace。
- Workspace isolation：`user_id` 级长期 workspace。

该接口不再使用笼统的 `mode: nsjail` 表述。
