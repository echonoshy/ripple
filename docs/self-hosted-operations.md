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

## Lightweight User Auth

轻量用户体系是一个可开关的外层产品壳。启用后，浏览器用户可以用邀请码认领账号并登录；后端仍然按 token 绑定的 `user_id` 隔离 sandbox、session、connector credential、runs 和 schedules。原有 service API key + `X-Ripple-User-Id` 可信上游模式继续可用。

启用配置：

```yaml
server:
  user_auth:
    enabled: true
    session_ttl_seconds: 2592000
```

启动长期服务：

```bash
cargo run -p ripple-server
```

指定配置文件启动：

```bash
RIPPLE_CONFIG=config/settings.yaml cargo run -p ripple-server
```

这个命令会一直占用终端并监听 HTTP 端口。配置变更后需要重启这个服务；如果原服务还在运行，再启动一个同端口服务会失败，但不会把原服务杀掉。

创建邀请码：

```bash
cargo run -p ripple-server -- auth create-invite --max-uses 1 --expires-days 14 --config config/settings.yaml
```

`auth create-invite` 是一次性管理命令：它只往 SQLite 写入邀请码并打印结果，不会启动 HTTP 服务，也不会影响正在运行的服务。`--max-uses 1` 表示这个邀请码只能认领 1 个用户；想邀请多个人，可以多创建几次，或把 `--max-uses` 调大。

查看用户：

```bash
cargo run -p ripple-server -- auth list-users --config config/settings.yaml
```

禁用用户：

```bash
cargo run -p ripple-server -- auth disable-user <login-or-user-id> --config config/settings.yaml
```

撤销用户所有登录态：

```bash
cargo run -p ripple-server -- auth revoke-sessions <login-or-user-id> --config config/settings.yaml
```

检查服务是否在线：

```bash
curl http://127.0.0.1:8810/health
```

用户登录相关公开接口：

- `GET /v1/auth/config`
- `POST /v1/auth/invite/claim`
- `POST /v1/auth/login`
- `POST /v1/auth/logout`

产品用户登录后，客户端使用 `Authorization: Bearer <session_token>` 调用 `/v1`。这种 token 会固定到自己的 `user_id`，后端会忽略客户端伪造的 `X-Ripple-User-Id`。

## Runtime Boundaries

Ripple 是控制面，Codex app-server 是服务端受信执行面宿主进程。

- Codex app-server 不运行在 user nsjail 内；Codex shell 命令由 Codex Linux sandbox/bubblewrap 和 Ripple managed permissions profile 约束。
- Codex job 权限 profile：根目录只读、当前 workspace 可写、整个 sandboxes root 和服务端 Codex auth deny-read、shell env 排除 `CODEX_HOME`。
- Connector CLI auth/status flow 通过 nsjail 运行时和 per-user credentials，要求 new pid/ipc/uts/user namespace、fresh `/proc`，并共享网络 namespace。
- User workspace 隔离单位是 `user_id`，同一 user 的 session 共享长期 workspace。
- Codex sandbox prerequisites 或 connector nsjail runtime probe 失败时按 fail-closed 处理，不静默降级执行。

不要把服务端 `CODEX_HOME/auth.json` 复制或挂载进 `.ripple/sandboxes/<user_id>/workspace/`。

## Document Preview Runtime

Workspace 文件预览里，PDF 会直接以内联 PDF 返回；Word、Excel、PowerPoint 等 Office 文件会先通过 LibreOffice 转成 PDF，再返回给前端只读查看。`soffice` 就是 LibreOffice 提供的命令行入口，所以部署机器需要安装 LibreOffice，否则 `.doc/.docx/.xls/.xlsx/.ppt/.pptx` 这类文件无法生成预览。

Ubuntu / Debian 安装：

```bash
sudo apt update
sudo apt install -y libreoffice libreoffice-writer libreoffice-calc libreoffice-impress
```

建议同时安装常见字体，尤其是中文文档需要 CJK 字体，否则转换后的 PDF 可能出现方块字、字体回退或排版偏移：

```bash
sudo apt install -y fonts-noto-cjk fonts-wqy-zenhei fonts-wqy-microhei fonts-dejavu fonts-liberation
```

安装后检查：

```bash
which soffice
soffice --version
```

常见路径是 `/usr/bin/soffice`。如果生产环境里 `soffice` 不在服务进程的 `PATH` 里，可以在 `config/settings.yaml` 显式指定：

```yaml
server:
  document_preview:
    libreoffice_path: "/usr/bin/soffice"
```

如果只是在机器上安装 LibreOffice，通常不需要重启 `ripple-server`。如果修改了 `config/settings.yaml`，需要重启服务让配置生效。

Fedora / RHEL 系发行版可使用对应包管理器安装：

```bash
sudo dnf install -y libreoffice libreoffice-writer libreoffice-calc libreoffice-impress google-noto-cjk-fonts
```

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

Doctor 会检查 SQLite、目录权限、Codex executable、bwrap/Codex Linux sandbox probe、nsjail config/runtime probe、connector CLI、CORS 和 trusted-proxy 姿态。
