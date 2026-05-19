# Rust + Tauri Migration Plan

> 状态：未来方案草案。当前 Python 版本服务稳定前，不建议启动主链路替换。
>
> 日期：2026-05-19

## 背景

Ripple 当前是运行在 Codex app-server 之上的 Agent 控制面：

- Python/FastAPI 负责用户、session、workspace、sandbox、connector、skill manifest、approval bridge、job/event/output 状态和 OpenAI-compatible API。
- Codex app-server 负责实际执行面：读写文件、运行命令、搜索代码、调用 CLI、使用 skills、完成任务。
- 前端已经是 TypeScript/React/Vite，另有移动端 React Native/Expo 实现。

未来如果希望把主服务切到 Rust，并通过 Tauri 打包桌面和移动端应用，推荐采用：

```text
TypeScript frontend
  -> Web browser / Tauri desktop / Tauri mobile
  -> Rust control-plane service
  -> Codex app-server + connector CLIs + Python skills/scripts
```

这里的关键点是：**Tauri 是客户端应用壳，不是服务端替代品**。真正替换 Python FastAPI 的应该是一个独立 Rust 服务；Tauri 负责把前端打包成 macOS、Windows、Linux、iOS、Android 应用。

## 迁移目标

### 目标

- 保留现有用户体验和 API 语义，减少前端重写成本。
- 用 Rust 重写 Ripple control plane，提高长期可维护性、部署稳定性、并发能力和二进制分发体验。
- 前端继续使用 TypeScript/React，Web 版和 App 版尽量共用 UI 与 API client。
- Python skills、pipeline 脚本、外部 CLI 继续保留，按子进程/JSON 协议被 Rust 服务调用。
- 移动端只包含前端和必要的本地能力，复杂执行仍在远程 Rust 服务中完成。

### 非目标

- 不在 iOS/Android 本地运行完整 Codex、nsjail、Python scripts 或任意 shell 工具链。
- 不把 Tauri 当成多用户后端服务器。
- 不在迁移初期重写所有 skills。
- 不为旧版 Python agent loop 恢复兼容层。
- 不改变 Codex-only runtime 的总体方向。

## 推荐总体架构

```text
clients/
  web/                    # 现有 TS/React/Vite 前端
  tauri/                  # Tauri shell，复用 web build
  mobile/                 # 可选：Tauri mobile 或继续 Expo/RN

server-rs/
  api/                    # HTTP/SSE/WebSocket API
  auth/                   # API key、上游 user id、权限边界
  sessions/               # session lifecycle + message history
  runs/                   # long-running Codex jobs
  workspace/              # 文件浏览、上传、下载、搜索、quota
  sandbox/                # user workspace、nsjail cfg、路径校验
  codex/                  # Codex app-server JSON-RPC provider
  connectors/             # Google/Feishu/Notion/Codex 状态与授权
  skills/                 # skill loader + manifest builder
  script_bridge/          # Python/CLI 子进程桥
  storage/                # SQLite/Postgres + object/file storage
```

### 部署形态

推荐优先支持远程服务模式：

```text
Desktop/mobile app
  -> HTTPS
  -> Rust Ripple service
  -> per-user workspace/sandbox
  -> Codex app-server
```

macOS desktop 后期可以增加本地模式：

```text
Tauri desktop app
  -> bundled local Rust service
  -> local workspace
  -> local Codex app-server
```

但本地模式会显著增加授权、更新、日志、数据迁移和安全边界复杂度，不建议作为第一阶段目标。

## Rust 服务技术选型

建议从以下组合开始：

- HTTP framework：`axum`
- async runtime：`tokio`
- serialization：`serde` / `serde_json`
- config：`config` 或 `figment`
- validation：`validator` 或自定义 typed validation
- logging/tracing：`tracing` / `tracing-subscriber`
- database：开发期 SQLite，生产期可切 Postgres；统一通过 `sqlx`
- SSE：`axum` response stream
- subprocess：`tokio::process::Command`
- file watching/search：先用 `ignore`/`walkdir`/`grep` 子进程，必要时再引入 Rust 原生索引
- secrets：服务端配置文件 + OS keyring/加密存储，避免写入 workspace

Rust 服务需要保持“控制面”定位。不要把 Codex 执行逻辑、LLM loop 或 Python skill 逻辑全部塞进 Rust。

## API 兼容策略

迁移时应先保持现有 API surface：

- `POST /v1/chat/completions`
- `POST /v1/runs`
- `GET /v1/runs`
- `GET /v1/runs/{job_id}`
- `GET /v1/runs/{job_id}/events`
- `POST /v1/runs/{job_id}/steer`
- `POST /v1/runs/{job_id}/cancel`
- `GET/POST /v1/sessions...`
- `GET/POST /v1/sandboxes...`
- `GET/POST /v1/connectors...`
- `GET/PUT/POST /v1/workspace...`

迁移原则：

- 前端 API client 不应感知 Python/Rust 实现差异。
- SSE event schema 先保持兼容，避免一次性重写前端 streaming/rendering。
- OpenAI-compatible 字段可以继续保留，即使部分字段只是兼容元数据。
- `X-Ripple-User-Id` 语义保持不变：上游负责身份，Ripple 负责隔离。

## 模块迁移映射

| 当前 Python 模块 | Rust 目标模块 | 迁移建议 |
| --- | --- | --- |
| `interfaces.server.routes` | `api` | 先按 endpoint 拆分 handler，不要照搬大文件 |
| `interfaces.server.sessions` | `sessions` | 优先迁移 session metadata/message store |
| `interfaces.server.codex_chat` | `api::chat` + `runs` | 保持 prompt builder 与 event conversion 的测试覆盖 |
| `ripple.agent_runners.codex_app_server` | `codex` | 重点迁移 JSON-RPC、per-user pool、approval、event stream |
| `ripple.agent_runners.manager` | `runs` | 用 typed state machine 管 job lifecycle |
| `ripple.sandbox.config/manager/workspace` | `sandbox` + `workspace` | 路径校验、quota、user workspace 是核心安全边界 |
| `ripple.connectors.registry` | `connectors` | 先保持 CLI/OAuth 行为兼容 |
| `ripple.skills.loader/manifest` | `skills` | Rust 只解析 manifest；skill 内容继续 Markdown/Python |
| `interfaces.server.workspace_browser` | `workspace` | 文件浏览/搜索适合 Rust 化 |

## Codex App-Server Provider

这是迁移中风险最高的部分，应作为单独里程碑处理。

Rust 侧需要实现：

- per-user Codex app-server 懒启动和 idle timeout。
- stdio JSON-RPC client。
- `initialize`、`thread/start`、`turn/start` 调用封装。
- managed permissions profile 注入。
- `CODEX_HOME` 环境隔离。
- service Codex auth 目录 deny-read。
- approval request 解析、持久化、转发。
- Codex notification -> Ripple event 的转换。
- job cancel/steer。
- app-server 崩溃后的恢复与错误上报。

迁移时不要先启用 persistent Codex thread。先保持当前策略：Ripple 自己持久化 session，Codex thread 可 ephemeral。等 user/plugin/MCP 状态隔离完全明确后，再考虑：

```text
(user_id, ripple_session_id) -> codex_thread_id
```

## Sandbox 与 Workspace

Rust 重写时必须保留以下边界：

- workspace 仍以 `user_id` 为隔离单位，而不是 session。
- 所有 workspace path 都必须经过 canonicalize/relative validation。
- `/workspace` 虚拟路径继续映射到宿主 user workspace。
- `default` user 的销毁限制继续保留。
- quota 检查必须覆盖 upload/save/import 等写入口。
- service `CODEX_HOME` 和 host `~/.codex` 不允许暴露给用户命令。

如果继续使用 nsjail：

- Rust 只负责生成 cfg 和启动短命令。
- 复杂任务仍交给 Codex managed permissions profile。
- 不要让移动端承担 nsjail 运行环境。

## Python Skills 与脚本兼容

Python skills/scripts 可以长期保留。推荐定义一个稳定脚本桥协议。

### 调用方式

```text
Rust service
  -> tokio::process::Command
  -> uv run python script.py
  -> stdin JSON
  -> stdout JSON / JSONL events
  -> stderr logs
```

### 输入约定

```json
{
  "user_id": "u_123",
  "workspace": "/abs/path/to/workspace",
  "cwd": "/abs/path/to/workspace/project",
  "env": {
    "RIPPLE_WORKSPACE": "/abs/path/to/workspace"
  },
  "args": {
    "topic": "..."
  }
}
```

### 输出约定

一次性任务：

```json
{
  "ok": true,
  "result": {
    "path": "/workspace/output.md"
  }
}
```

长任务：

```jsonl
{"type":"progress","message":"downloading"}
{"type":"artifact","path":"/workspace/output.md"}
{"type":"done","ok":true}
```

### 规则

- Python 脚本只能通过 workspace 和明确传入的 credential path 工作。
- 不允许脚本读取服务端 Codex auth。
- 脚本退出码非 0 时，Rust 记录 stderr tail 并转成 structured error。
- 脚本协议优先 JSON，不要依赖脆弱的字符串解析。
- 高频/性能瓶颈脚本后期再逐个 Rust 化。

## Tauri 客户端方案

### Desktop

桌面端推荐用 Tauri 2：

```text
src/interfaces/web
  -> vite build
  -> Tauri WebView
  -> remote Rust service API
```

桌面端可增加：

- 系统通知。
- 文件选择器。
- 本地文件拖拽上传。
- deep link。
- 自动更新。
- 本地日志导出。

第一阶段不要把完整服务端塞进 Tauri。保持客户端轻量，降低打包和发布复杂度。

### iOS / Android

移动端推荐策略：

- App 只作为前端客户端。
- 所有 Codex、Python、CLI、sandbox、长任务在远程 Rust 服务执行。
- 移动端上传文件、查看 session、查看 event stream、处理 approval。
- OAuth callback 可通过 universal link/deep link 回到 App，或者先复用浏览器 callback。

Tauri mobile 可作为一个方向，但需要单独 PoC。移动端 Tauri 生态比桌面年轻，插件覆盖和调试体验需要验证。若现有 React Native/Expo 移动端已经稳定，可以继续保留移动端 RN，桌面先用 Tauri。

## 数据存储建议

当前 Python 版本主要依赖文件/JSONL 状态。Rust 版本建议引入明确 storage layer：

### 开发/单机

- SQLite：sessions、runs、events index、connector state metadata。
- workspace 文件仍落磁盘。
- task outputs/artifacts 仍落 workspace 或 runtime dir。

### 生产/多实例

- Postgres：sessions、runs、events、approval、connector metadata。
- 对象存储：大附件、导出文件、artifact。
- Redis/NATS：可选，用于 run event fanout 或 worker dispatch。

迁移初期可以先 SQLite，保持单机部署简单。

## 性能收益判断

Rust 化收益明显的部分：

- 大量并发 SSE/run 状态管理。
- 文件遍历、workspace search、quota 统计。
- 子进程池、app-server lifecycle、timeout/cancel。
- 长期运行服务的内存占用和错误边界。
- 单二进制部署和启动速度。

Rust 化收益有限的部分：

- LLM/Codex 主延迟。
- 外部 OAuth provider 响应时间。
- Python skill 内部依赖第三方 API 的任务。
- CLI 自身执行耗时。

因此迁移理由应以产品化和可维护性为主，性能为辅。

## 迁移阶段

### Phase 0：冻结现有 Python 主链路

完成条件：

- Python 版 Codex-only runtime 稳定。
- chat/runs/workspace/connectors/sessions 测试覆盖清晰。
- API schema 和 SSE event schema 有文档。
- 明确哪些 legacy route 可删除。

产物：

- API contract 文档。
- 关键端到端测试用例。
- 当前行为 fixture。

### Phase 1：Rust service skeleton

实现：

- config loader。
- health/models endpoint。
- user id extraction。
- structured error。
- tracing/logging。
- basic test harness。

目标：

- Rust 服务能独立启动。
- 前端可配置连接 Rust 或 Python backend。

### Phase 2：workspace + sessions

实现：

- user workspace 创建/摘要/销毁。
- workspace list/upload/download/preview/save/search。
- session create/list/get/delete。
- message history persistence。

目标：

- 前端非 Codex 页面可跑在 Rust backend 上。

### Phase 3：runs/job manager

实现：

- run create/list/get/cancel。
- event persistence。
- SSE stream。
- approval pending state。
- steer/cancel API shell。

目标：

- 能跑 mock provider，前端 streaming 不需要改。

### Phase 4：Codex app-server provider

实现：

- per-user app-server pool。
- stdio JSON-RPC。
- prompt build。
- permission profile。
- event normalization。
- approval bridge。

目标：

- `/v1/runs` 与 `/v1/chat/completions` 在 Rust backend 上可执行真实 Codex 任务。

### Phase 5：connectors

实现：

- Codex connector status。
- Google Workspace/gog auth/status/accounts。
- Feishu/Lark auth/status。
- Notion token set/disconnect。

目标：

- connector 状态与执行环境一致，不出现“状态已登录、执行未登录”。

### Phase 6：Tauri desktop

实现：

- Tauri shell。
- 复用 web build。
- remote API config。
- desktop file picker/upload。
- app logging 和 update 策略。

目标：

- macOS desktop 可日常使用。

### Phase 7：mobile strategy

选择一条路线：

- 路线 A：继续 React Native/Expo，连接 Rust backend。
- 路线 B：Tauri mobile PoC，通过后再替代 RN。

验证重点：

- iOS/Android streaming 稳定性。
- file picker/upload。
- deep link/OAuth callback。
- push notification。
- background/resume 行为。

## 测试策略

Rust 版本至少需要覆盖：

- path validation escape cases。
- user workspace isolation。
- session persistence。
- run lifecycle state machine。
- SSE reconnect/event ordering。
- Codex JSON-RPC mock provider。
- approval request/response。
- connector auth/status mocked flows。
- workspace quota。
- Python script bridge stdout/stderr/timeout/cancel。

建议保留一组 Python 版行为 fixture，用于 Rust 实现 parity test。

## 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Codex app-server 协议变化 | runs/chat 失败 | provider 单独封装，mock 协议测试 |
| 移动端 Tauri 插件不足 | iOS/Android 发布受阻 | 移动端先保留 Expo/RN，Tauri mobile 单独 PoC |
| Python scripts 环境复杂 | 打包/部署不稳定 | Rust 服务端统一管理 uv/python env，不放到移动端 |
| OAuth callback 与 App deep link 复杂 | connector 体验差 | 第一阶段继续浏览器 callback，后续再接 deep link |
| 多用户 credential 泄漏 | 严重安全问题 | credential 不进 workspace，env 显式注入，path deny-read |
| 一次性重写过大 | 长期分叉 | 按 endpoint/provider 阶段迁移，前端用同一 API contract |

## 决策建议

等当前 Python 服务稳定后，推荐按以下顺序执行：

1. 先补齐 Python 版 API/event contract 文档和端到端测试。
2. Rust 先做 workspace/session/runs 的骨架，不碰 Codex。
3. Codex app-server provider 单独迁移，作为核心里程碑验收。
4. Python skills 保持子进程桥，不急着重写。
5. 先做 Tauri desktop；移动端是否切 Tauri 等 PoC 结果。

一句话方案：

```text
Rust 替换 Ripple control plane；Tauri 打包客户端；Python skills/CLI 继续作为受控子进程；移动端只做前端，不承载后端执行面。
```
