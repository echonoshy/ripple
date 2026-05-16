# AGENTS.md

本文件为 OpenAI Codex / Codex CLI 提供项目工作指南，是本仓库的唯一项目级 Agent 入口。

## 优先级

- 用户当前请求和系统/开发者指令优先级最高。
- 本文件是 Codex 的项目入口；不要再依赖其他 Agent 专用说明文件。
- 如果子目录存在更近的 `AGENTS.md`，在该子目录工作时同时遵守子目录说明。

## 项目速览

**ripple** 是运行在 Codex app-server 之上的 Agent 控制面，包含 FastAPI Server、user 级 nsjail 沙箱、Session/Run 状态管理、Connector 鉴权、Skill manifest 注入和 Next.js Web 前端。

当前主链路是 **Codex-only runtime**：

- Ripple 管理控制面：用户、会话、沙箱、凭证、权限桥接、任务状态、API 边界。
- Codex app-server 管理执行面：读写文件、运行命令、搜索代码、调用 CLI、使用 skills、完成实际任务。
- Ripple 不再运行旧版内置 `agent_loop`，也不再把 Bash/Read/Write 作为 server model-facing tools 暴露给模型。

仓库信息：

- 远程仓库：`https://github.com/echonoshy/ripple.git`
- 主分支：`master`
- 后端：Python 3.13+
- 前端：TypeScript / React / Next.js

主要目录：

```text
src/
  ripple/              # Python 核心库
    agent_runners/     # Codex app-server 外部执行器
    connectors/        # Connector 元数据、状态和鉴权动作
    core/              # ToolUseContext 等共享上下文；不含旧 Agent Loop
    tools/             # 工具抽象和兼容/内部工具；Server chat 主链不直接暴露
    skills/            # Skill 系统
    messages/          # 消息类型
    utils/             # 工具函数
    permissions/       # 权限管理
    sandbox/           # nsjail 沙箱管理
    tasks/             # 后台任务管理
  interfaces/
    server/            # FastAPI Server
    web/               # Next.js + TypeScript 前端
tests/                 # pytest 测试
scripts/               # 辅助脚本
config/                # YAML 配置
skills/                # 共享 Skills
```

## 常用命令

后端：

```bash
uv run ripple
uv run ripple --reload
uv run pytest
uv run ruff format .
uv run ruff check .
```

前端：

```bash
cd src/interfaces/web
bun run dev
bun run build
bun run lint
bun run format
```

网络相关测试、debug 或启动项目前，按本项目约定先执行：

```bash
proxy_on
```

## 迭代与清理原则

- 本项目处于快速迭代阶段，优先保持当前主链路清晰、简单、可验证；不要为了旧实现保留过多向后兼容代码或文档。
- 遇到已经失效的 legacy 代码、兼容层、配置、脚本或文档时，应主动识别并提出清理建议。
- 执行实质性清理前，先说明准备清理的范围、原因和潜在影响，得到用户确认后再动手。
- 新增或更新文档时，同步检查相关旧文档是否过时；过时内容要更新、删除或明确标注，避免后续执行被误导。

## 编码纪律

- 修改 Python 后运行 `uv run ruff format .`、`uv run ruff check .`，并按风险运行相关 `pytest`。
- 修改前端后在 `src/interfaces/web` 运行 lint/format/build 或相应最小验证。
- 不要创建无必要的 `__init__.py`。
- Python 使用内置泛型注解，如 `list[str]`、`dict[str, str]`。
- 不要新增 `from __future__ import annotations`。
- 路径操作优先用 `pathlib`。
- 不使用 `.env` 保存配置；配置统一放 `config/*.yaml`。
- 核心系统使用 async/await；工具执行也是异步优先。
- 工作树可能已有用户改动；不要回滚与当前任务无关的改动。
- 遇到问题时优先找结构化、可验证的根因方案，不要上来就用脆弱的正则或临时字符串处理绕过去。

## 配置

- 主配置文件：`config/settings.yaml`
- 配置文件使用 YAML 格式。
- API key、模型设置、agent 参数等放在 `config/` 下。
- 前端配置集中在 `src/interfaces/web/package.json`、`eslint.config.mjs`、`tsconfig.json`。

## Server / Codex 当前链路

当前 Server 端采用控制面 / 执行面分离：

- **Ripple Control Plane**：FastAPI、鉴权、`X-Ripple-User-Id`、session lifecycle、sandbox lifecycle、connector auth/status、skill manifest、approval bridge、job/event/output 状态。
- **Codex Execution Plane**：服务端预装的 `codex app-server --listen stdio://`，由 Ripple 按 user 懒启动为可信服务端进程；Codex 使用服务端统一 `CODEX_HOME`/登录态，实际任务限定在当前 user 的宿主侧 workspace。

Codex 授权是服务端统一授权，不是 per-user 授权：

- `external_agents.codex.codex_home` 为 `null` 时使用服务端进程的 `CODEX_HOME` 或 `~/.codex`；生产建议配置为独立的服务端目录，如 `.ripple/codex-service-home`。
- 不要把 Codex `auth.json` 复制、挂载或保存到 `sandboxes/<uid>/workspace/`；user sandbox 只保存用户文件和 per-user connector 凭证。
- `run_app_server_in_user_sandbox` 默认必须为 `false`。仅为兼容/实验目的打开时，才允许把 app-server 进程本身放进 nsjail。
- Connector 状态检查应使用与 app-server 相同的 `codex_home` / env，避免“状态已登录、执行未登录”。
- 真实探针确认：仅使用 legacy `workspaceWrite` 时，Codex command 执行层仍可读取服务端 `CODEX_HOME/auth.json` 和宿主 `~/.codex/auth.json`。因此默认链路必须使用 Codex managed permissions profile：`:root = read`、`:project_roots` 下 `.` 和 `.git` 可写但 `.agents` / `.codex` 只读、服务端 `codex_home` 与宿主 `.codex` 显式 `none` deny-read，并通过 `shell_environment_policy.exclude = ["CODEX_HOME"]` 避免把服务端 auth 路径传给命令环境。

`/v1/chat/completions` 主链路：

1. `interfaces.server.app:create_app` 启动 FastAPI，创建 `SandboxManager` 和 `SessionManager`。
2. `routes.chat_completions` 校验 API key，读取 `X-Ripple-User-Id`，提取最后一条 user message 和 caller system prompt。
3. `SessionManager.get_or_create_session` 创建或恢复 session；首次使用会创建当前 user 的 sandbox，并绑定 `workspace_root`、`session_runtime_dir`、`sandbox_manager`。
4. `interfaces.server.codex_chat.build_codex_chat_prompt` 生成给 Codex 的单轮 prompt，包含 Ripple/Codex 职责说明、user/session、connector 状态、skill manifest、历史对话和当前请求。
5. `ripple.agent_runners.service.start_agent_run` 校验 cwd 必须在 user workspace 内，把宿主 workspace 路径写入 request，并把 `sandbox_config` 写入 metadata 供 app-server 进程构建 per-user connector/env。
6. `ExternalAgentManager` 启动 job，provider 目前只支持 `codex`。
7. `CodexAppServerAgentProvider` 为每个 user 懒启动一个可信服务端 Codex app-server 进程；默认不套 user nsjail，但会注入服务端 `CODEX_HOME` 和 user workspace 语义的 `HOME` / connector env。
8. Provider 通过 JSON-RPC 调用 Codex：`initialize`、`thread/start`、`turn/start`；`thread/start` 通过 request `config` 注入 `ripple_workspace` permissions profile，并用 `permissions: {type: "profile", id: "ripple_workspace"}` 选中它。
9. Codex app-server 以宿主侧 user workspace 为 `cwd`，通过 Codex managed permissions profile 限制读写：根目录只读、当前 project roots 可写、服务端 Codex auth 目录不可读；完成后把 delta/event/output 写回 Ripple。
10. Ripple 把结果转换为 OpenAI-compatible response 或 SSE，并把 user/assistant 消息持久化到 session。

`/v1/runs` 是独立的 Codex job API，适合外部调度器或前端直接发起长任务；它同样落到 `start_agent_run(... provider=codex ...)`。

当前明确移除或不在主链使用的内容：

- `src/ripple/core/agent_loop.py`、`QueryState`、旧 OpenRouter/OpenAI client 主循环等 legacy runtime 已移除。
- `/v1/tools/invoke` 返回 `410`，不再提供 Ripple tool execution。
- `get_server_tool_names()` 返回空数组；Server chat 主链没有 model-facing Ripple tools。
- `max_turns`、`thinking`、token `usage` 等字段主要为兼容 OpenAI-compatible 调用方保留，实际执行由 Codex app-server 决定。
- 内嵌 scheduler API 已移除；未来/周期任务应由外部调度器调用 `/v1/runs` 并携带正确的 `X-Ripple-User-Id`。

## User 沙箱层

沙箱以 **user_id** 为隔离单位，而不是 session_id。一个 user 对应一个长期存在的 workspace，其下可开多个 session；同一 user 的多个 session 共享 workspace，通过 user 级 `asyncio.Lock` 保证工具调用互斥。

调用方通过 HTTP header `X-Ripple-User-Id: <uid>` 传入 user_id；缺失时回落到 `default`。user_id 合法字符集为 `[a-zA-Z0-9_-]{1,64}`。ripple 不做身份鉴权，由上游业务系统保证 user_id 的有效性与隔离语义。

Codex app-server 的工作目录是宿主侧 `.ripple/sandboxes/<user_id>/workspace/`。同一 user 的不同 session 会共享这个 workspace；session 目录只保存对话和运行时状态。对 Codex prompt 应优先描述“current working directory / relative paths”，不要假设 `/workspace` 在可信 app-server 进程中存在。

管理端点：

- `POST /v1/sandboxes`：幂等为当前 user 创建 sandbox。
- `GET /v1/sandboxes`：返回当前 user sandbox 摘要。
- `DELETE /v1/sandboxes`：销毁当前 user 的整个 sandbox；`default` user 禁止销毁。

运行时目录 `.ripple/` 由 Server 在首次运行时创建，不纳入版本控制：

```text
.ripple/
├── logs/
│   └── ripple.log
├── sandboxes-cache/
│   ├── uv-cache/
│   ├── corepack-cache/
│   └── pnpm-store/
└── sandboxes/
    └── <user_id>/
        ├── workspace/
        ├── nsjail.cfg
        ├── credentials/
        │   ├── feishu.json
        │   ├── notion.json
        │   ├── gogcli-client.json
        │   └── gogcli-keyring.pass
        └── sessions/
            └── <session_id>/
                ├── meta.json
                ├── messages.jsonl
                ├── tasks.json
                └── task-outputs/
```

## Skill 系统

Skills 是带 YAML frontmatter 的 Markdown 文件，定义特定领域的任务模板。

加载层级：

1. Shared Skills：来自 `skills.shared_dirs` 配置，默认 `skills/shared`，所有 session 可见。
2. Workspace Skills：来自每个 session 沙箱内的 `workspace/skills/`。

Skill 文件格式：

- 文件名为 `SKILL.md`，或含 YAML frontmatter 且有 `name` / `description` 字段。
- 常用 frontmatter 字段：`name`、`description`、`arguments`、`allowed-tools`、`context`、`when-to-use`。
- 详细文档见 `docs/SKILLS.md`。

Codex-only runtime 下，Ripple 主要把 skill 作为 manifest 注入 prompt，而不是通过 `SkillTool` 让模型回调 Server：

- Shared Skills readonly mount 到 `/opt/ripple/skills/shared/<index>-<name>/...`。
- Workspace Skills 位于 `/workspace/skills/...`。
- nsjail 短命令仍会使用上述沙箱路径；Codex app-server prompt 的 skill manifest 应提供服务端可见的宿主路径。
- Codex 看到 manifest 后，应自行读取对应 `SKILL.md` 和相邻资源文件。

## 架构索引

Server 控制面：

- `src/interfaces/server/app.py`：FastAPI 入口，创建 `SandboxManager` / `SessionManager`。
- `src/interfaces/server/routes.py`：OpenAI-compatible API、session、sandbox、runs、connectors、workspace 路由。
- `src/interfaces/server/sessions.py`：Session 内存/磁盘生命周期、默认 system prompt、sandbox context。
- `src/interfaces/server/codex_chat.py`：Chat Completions 到 Codex runner 的桥接。
- `src/interfaces/server/workspace_browser.py`：workspace 目录浏览和文本预览。
- `src/interfaces/server/middleware.py`：request/user/session 日志上下文。

Codex 执行面：

- `src/ripple/agent_runners/service.py`：创建 Codex run，校验 cwd，注入 sandbox metadata。
- `src/ripple/agent_runners/manager.py`：内存 job 管理、取消、steer、approval 转发。
- `src/ripple/agent_runners/codex_app_server.py`：Codex app-server JSON-RPC provider，每 user 懒启动可信服务端进程，统一服务端 Codex auth。
- `src/ripple/agent_runners/approvals.py`：Codex approval request 解析和响应映射。

沙箱与 Connector：

- `src/ripple/sandbox/config.py`：user sandbox 路径、资源限制、CLI 发现、凭证路径。
- `src/ripple/sandbox/manager.py`：user sandbox/session 生命周期。
- `src/ripple/sandbox/nsjail_config.py`：nsjail cfg、mount、env 注入。
- `src/ripple/sandbox/executor.py`：内部需要时执行短命令的 nsjail runner。
- `src/ripple/connectors/registry.py`：Google Workspace、Notion、Feishu、Bilibili、Codex CLI connector。

工具系统：

- `src/ripple/tools/base.py`：BaseTool 抽象类。
- `src/ripple/tools/orchestration.py`：兼容工具执行编排；Server chat 主链不使用。
- `src/ripple/tools/builtin/`：内置/兼容工具；不要假设它们会暴露给 Codex chat。

Skill 系统：

- `src/ripple/skills/loader.py`：加载 shared 和 workspace skills。
- `src/ripple/skills/executor.py`：执行 skills。
- `src/ripple/skills/skill_tool.py`：SkillTool 包装器。
- `src/ripple/skills/manifest.py`：生成 Codex-facing skill manifest 和 shared skill mount。

消息：

- `src/ripple/messages/types.py`：消息类型。
- `src/ripple/messages/utils.py`：消息规范化。

接口层：

- `src/interfaces/server/`：FastAPI Server，入口为 `interfaces.server.app:main`。
- `src/interfaces/web/`：Next.js + React 前端。

## 外部 CLI

三个通过 `vendor/` 目录托管的静态二进制，沙箱启动时 readonly bind-mount 到 `/opt/<name>/`：

| CLI | 安装脚本 | 宿主安装位置 | 沙箱路径 | 鉴权方式 |
| --- | --- | --- | --- | --- |
| `lark-cli` | `bash scripts/install-feishu-cli.sh` | `vendor/lark-cli/v<X.Y.Z>/bin/` | `/opt/lark-cli/current/bin/lark-cli` | per-user OAuth，凭证落在 `sandboxes/<uid>/workspace/.lark-cli/` |
| `ntn` | `bash scripts/install-notion-cli.sh` | `vendor/notion-cli/v<X.Y.Z>/bin/` | `/opt/notion-cli/current/bin/ntn` | 用户粘贴 token，经 `NotionTokenSet` 存入 `sandboxes/<uid>/credentials/notion.json` |
| `gog` | `bash scripts/install-gogcli-cli.sh` | `vendor/gogcli-cli/v<X.Y.Z>/bin/` | `/opt/gogcli-cli/current/bin/gog` | 部署级 Google Web OAuth Client + per-user refresh token |

下载失败时打印手工安装指引，不自动重试。版本切换命令为 `bash scripts/use-<name>-cli.sh <version>`。

## gog / Google Workspace 当前约定

首次使用任何 gog 能力前，必须先读 `skills/gog/gog-shared/SKILL.md`。

`gog` 当前只保留基础 Workspace 服务：

```text
gmail, drive, calendar, docs, sheets, slides
```

已移除/暂不支持的 gog skill：Tasks、People/Contacts、Classroom、Admin、Chat、Forms、Apps Script 等。

授权模型：

- 管理员在 `config/settings.yaml` 配置一次 `server.gogcli_oauth.client`。
- 前端或调用方通过 `/v1/connectors/google_workspace/auth/start` 发起授权；Server 会把部署级 OAuth Client 自动注册到当前 `user_id` 的 gogcli 配置。
- 授权命令只请求基础服务：`--services gmail,drive,calendar,docs,sheets,slides`。
- 用户仍需在浏览器打开授权 URL 并点击 Allow。
- assisted callback 成功后，refresh token 加密保存到当前 user workspace 的 `/workspace/.config/gogcli/keyring/`。
- `/v1/connectors/google_workspace/accounts?check=true` 用于查看/验活当前 user 已绑账号。
- Codex 执行业务时在当前 user workspace 内调用 `gog` CLI；Ripple 只负责授权、凭证注入、状态展示和执行环境/env。

当前 gog skills：

- `skills/gog/gog-shared`
- `skills/gog/gog-gmail`
- `skills/gog/gog-drive`
- `skills/gog/gog-calendar`
- `skills/gog/gog-docs`
- `skills/gog/gog-sheets`
- `skills/gog/gog-slides`

破坏性 gog 操作必须先让用户明确确认，尤其是：

- Gmail send/reply/forward/delete
- Drive delete/share/unshare/replace
- Calendar create/update/delete/respond
- Docs write/sed/find-replace
- Sheets update/clear/delete-tab
- Slides create/copy/find-replace/batch-update
- `GoogleWorkspaceLogout`

执行 gog 命令时，每条命令显式指定账号：

```bash
gog --account <email> --json gmail search "newer_than:7d" --max 5
```

## 安全

- 不要把 API key、token 等敏感信息提交到未被 `.gitignore` 忽略的文件。
- 临时测试文件如果包含敏感信息，测试完毕后删除或明确提示风险。

## 本地参考项目

- Codex 源码： `/home/lake/workspace/codex`
