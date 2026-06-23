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
