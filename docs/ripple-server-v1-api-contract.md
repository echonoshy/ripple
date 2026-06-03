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

管理员通过 CLI 管理邀请码和用户：`ripple-server auth create-invite`、`list-users`、`disable-user`、`revoke-sessions`。

## Generated API Docs

- `GET /openapi.json` 返回由 Rust handler annotation 和 schema derive 生成的 OpenAPI spec。
- `GET /docs` 提供 Swagger UI，默认读取 `/openapi.json`。
- `server.api_docs.enabled` 可关闭文档入口；`server.api_docs.try_it_out_enabled` 控制 Swagger UI 是否默认展开 Try it out。
- 文档入口不包含 API key，受保护 `/v1` API 的鉴权行为不变。
- 当前优先自动覆盖 health、models/info、chat、runs 和 connector 管理接口。仍返回 `Json<Value>` 的响应会先以宽松 JSON schema 表达，后续类型化 response struct 后 schema 会进一步自动同步。

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

列表接口开始支持 `limit` 和 `cursor`，返回 `count`、`total`、`next_cursor`：

- `GET /v1/sessions?limit=50&cursor=50`
- `GET /v1/runs?limit=50&cursor=50`
- `GET /v1/schedules?limit=50&cursor=50`

`cursor` 当前是稳定的 offset 字符串，客户端应只把它当 opaque token 传回。

## Runs

- `GET /v1/runs/:job_id/events` 返回 SSE，每个 JSON event 带 `event_version: 1`。
- `GET /v1/runs/:job_id/output` 下载 run output，不要求客户端读取 host path。
- `events_file` 和 `output_file` 仍保留给管理员调试，客户端不要依赖它们作为下载入口。
- 服务重启时遗留 `queued/running` run 会标记为 `failed`，`failure_reason=interrupted_by_restart`。

## Risk Confirmation

高风险后端 API 要求 JSON body 带 `confirm: true`，并写入 `.ripple/audit.jsonl`：

- `DELETE /v1/sandboxes`
- `POST /v1/workspace/delete`
- `POST /v1/connectors/:connector_name/disconnect`
- `DELETE /v1/schedules/:schedule_id`

缺少确认时返回 `428 confirmation_required`。

## Connector Management

`GET /v1/connectors` 返回每个 connector 的可用管理入口。`user_connector` 会暴露 web/chat 授权能力、`auth_start_path`、可选 `auth_complete_path`、`auth_cancel_path`、`disconnect_path`、`accounts_path` 和能力标记；`runtime_capability` 不暴露 per-user 授权或断开入口。

- `POST /v1/connectors/:connector_name/auth/cancel` 取消当前 user 的待授权状态，幂等返回 `{ ok, connector, cancelled }`。它会清理 connector runtime pending state，例如 Google assisted OAuth、Feishu setup 进程、Bilibili QR pending state，并清掉该 user 相关 session 的 pending connector auth。
- `POST /v1/connectors/:connector_name/disconnect` 是本地断开。它删除 Ripple user sandbox 里的 token、keyring、cookie 或 CLI 配置，不承诺撤销 provider 侧授权。Google 支持 `{ email }` 删除单个本地账号 token，也支持 `{ all: true }` 清理本地 Google keyring。
- `GET /v1/capabilities` 返回内部统一能力目录，合并 connectors、runtime capabilities、Ripple shared skills 和当前 user workspace skills；前端普通用户页面不直接展示 runtime capability 分类。
- `GET /v1/skills` 返回用户侧 skill 列表，不包含 runtime capability。
- `POST /v1/skills` 创建当前 user 的 skill 草稿。
- `GET /v1/skills/:skill_id` 返回单个 skill 详情。
- `PATCH /v1/skills/:skill_id` 支持编辑、启用和停用 `user:*` skill；`ripple:*` shared skills 只读。
- `DELETE /v1/skills/:skill_id` 需要 `{ confirm: true }`，归档 user skill，不物理丢失。
- `POST /v1/skills/:skill_id/validate` 执行格式、安全、依赖和测试样例校验。新建或修改后的 user skill 校验通过前不能启用，也不会注入 Codex prompt。

## Health And Diagnostics

- `GET /health`：公开活性检查。
- `GET /v1/health/ready`：就绪检查，覆盖 SQLite、sandbox 目录、Codex executable。
- `GET /v1/diagnostics/doctor`：管理员诊断，覆盖安全姿态、CORS、SQLite、目录、Codex executable、bwrap/Codex Linux sandbox probe、nsjail config/runtime probe、connector CLI 和 backup contract。

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
