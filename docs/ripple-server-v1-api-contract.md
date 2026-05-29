# Ripple Server v1 API Contract

本契约描述 `ripple-server` 当前的单机自托管 `/v1` API 约定。目标是兼容现有客户端，同时把新增成熟化字段做成非破坏式扩展。

## Auth

- 受保护路由使用 `Authorization: Bearer <server_api_key>` 或 `X-API-Key`。
- `X-Ripple-User-Id` 是用户隔离入口，合法字符为 `[a-zA-Z0-9_-]{1,64}`。
- 生产推荐 `trusted-proxy`：普通浏览器不直接持有 server API key；上游认证后注入 `X-Ripple-User-Id`，并剥离客户端伪造 header。

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

## Health And Diagnostics

- `GET /health`：公开活性检查。
- `GET /v1/health/ready`：就绪检查，覆盖 SQLite、sandbox 目录、Codex executable。
- `GET /v1/diagnostics/doctor`：管理员诊断，覆盖安全姿态、CORS、SQLite、目录、Codex、nsjail、connector CLI 和 backup contract。

CLI 同步提供：

```bash
cargo run -p ripple-server -- doctor --config config/settings.yaml
```

## Sandbox Info

`GET /v1/sandbox/info` 明确区分：

- Codex execution：managed permissions profile。
- Connector CLI：nsjail runtime。
- Workspace isolation：`user_id` 级长期 workspace。

该接口不再使用笼统的 `mode: nsjail` 表述。
