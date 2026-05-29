# Ripple Server Single-Node Operations

`ripple-server` v1 的生产定位是可信团队使用的单机自托管 Agent 控制面。它不承诺公网 SaaS、多节点高可用，或不可信用户之间的强 OS 隔离。

## Deployment Posture

推荐拓扑：

```text
Browser / App
    |
Trusted Web / Reverse Proxy
    | injects X-Ripple-User-Id, strips spoofed user headers
Ripple Server :8810
    |
Codex app-server per job
```

关键要求：

- 普通浏览器不要直接保存 server API key。
- 上游业务系统负责用户认证和 `X-Ripple-User-Id` 真实性。
- `server.security.deployment_mode` 保持 `trusted-proxy`。
- 生产 CORS 使用明确 allowlist，不使用 `allow_any_origin`。
- 恢复 HTTPS 域名后，将 `require_https` 设为 `true`，并同步客户端默认 API、Tauri CSP/ATS/cleartext 配置。

## Runtime Boundaries

Ripple 是控制面，Codex app-server 是执行面。

- Codex job 使用 Ripple managed permissions profile：根目录只读、project roots 可写、服务端 Codex auth deny-read。
- Connector CLI auth/status flow 通过 nsjail 运行时和 per-user credentials。
- User workspace 隔离单位是 `user_id`，同一 user 的 session 共享长期 workspace。

不要把服务端 `CODEX_HOME/auth.json` 复制或挂载进 `.ripple/sandboxes/<user_id>/workspace/`。

## Backup Contract

建议停服务或冻结写入后备份：

必须包含：

- `.ripple/ripple.sqlite`
- `.ripple/ripple.sqlite-wal`
- `.ripple/ripple.sqlite-shm`
- `.ripple/sandboxes/<user_id>/workspace`
- `.ripple/sandboxes/<user_id>/credentials`
- `.ripple/sandboxes/<user_id>/agent-runs`
- `.ripple/sandboxes/<user_id>/sessions`

可排除：

- `.ripple/sandboxes-cache`

Codex auth 建议恢复后重新登录服务端专用 `CODEX_HOME`，不要把 auth 文件放入 user workspace。

## Upgrade And Restart

- SQLite schema 通过 `schema_migrations` 记录版本。
- 升级前先按 backup contract 做备份。
- 服务启动时，旧的 `queued/running` jobs 会标记为 `interrupted_by_restart`，客户端可重试。
- Run output 下载使用 `/v1/runs/:job_id/output`，不要依赖 host path。

## Schedules

默认策略：

- `missed_run_policy=run_once`：服务恢复后对错过的 due schedule 补跑一次。
- `overlap_policy=skip`：上一轮仍在运行时跳过本轮。
- `failure_policy=pause`：启动失败时暂停并记录 `failure_reason`。

前端 Automations 页面展示这些 policy、last run status、failure reason 和 retry/run-now。

## Diagnostics

HTTP：

```bash
curl -H "Authorization: Bearer $RIPPLE_SERVER_API_KEY" \
  http://127.0.0.1:8810/v1/diagnostics/doctor
```

CLI：

```bash
cargo run -p ripple-server -- doctor --config config/settings.yaml
```

Doctor 会检查 SQLite、目录权限、Codex executable、nsjail、connector CLI、CORS 和 trusted-proxy 姿态。
