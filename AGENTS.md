# AGENTS.md

本文件为 OpenAI Codex / Codex CLI 提供项目工作指南，是本仓库的唯一项目级 Agent 入口。

## 优先级

- 用户当前请求和系统/开发者指令优先级最高。
- 本文件是 Codex 的项目入口；不要再依赖其他 Agent 专用说明文件。
- 如果子目录存在更近的 `AGENTS.md`，在该子目录工作时同时遵守子目录说明。

## 项目速览

**ripple** 是 Agent 系统，包含 agentic loop、工具调用、Skill 系统、Hook 验证、FastAPI Server 和 Next.js Web 前端。

仓库信息：

- 远程仓库：`https://github.com/echonoshy/ripple.git`
- 主分支：`master`
- 后端：Python 3.13+
- 前端：TypeScript / React / Next.js

主要目录：

```text
src/
  ripple/              # Python 核心库
    core/              # Agent Loop 核心
    api/               # API 客户端
    tools/             # 工具系统
    skills/            # Skill 系统
    hooks/             # Hook 系统
    messages/          # 消息类型
    utils/             # 工具函数
    permissions/       # 权限管理
    sandbox/           # nsjail 沙箱管理
    compact/           # 上下文压缩
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

## User 沙箱层

沙箱以 **user_id** 为隔离单位，而不是 session_id。一个 user 对应一个长期存在的 workspace，其下可开多个 session；同一 user 的多个 session 共享 workspace，通过 user 级 `asyncio.Lock` 保证工具调用互斥。

调用方通过 HTTP header `X-Ripple-User-Id: <uid>` 传入 user_id；缺失时回落到 `default`。user_id 合法字符集为 `[a-zA-Z0-9_-]{1,64}`。ripple 不做身份鉴权，由上游业务系统保证 user_id 的有效性与隔离语义。

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

## 架构索引

核心 Agent Loop：

- `src/ripple/core/agent_loop.py`：主查询循环。
- `src/ripple/core/state.py`：QueryState 跟踪对话历史和轮次计数。
- `src/ripple/core/context.py`：ToolUseContext 管理工具、会话信息和工作目录。
- `src/ripple/core/transitions.py`：状态机转换。

工具系统：

- `src/ripple/tools/base.py`：BaseTool 抽象类。
- `src/ripple/tools/orchestration.py`：处理并发/串行工具执行。
- `src/ripple/tools/builtin/`：内置工具。

Skill 系统：

- `src/ripple/skills/loader.py`：加载 shared 和 workspace skills。
- `src/ripple/skills/executor.py`：执行 skills。
- `src/ripple/skills/skill_tool.py`：SkillTool 包装器。

消息与 API：

- `src/ripple/messages/types.py`：消息类型。
- `src/ripple/messages/utils.py`：消息规范化。
- `src/ripple/api/client.py`：OpenRouterClient 封装。
- `src/ripple/api/streaming.py`：流式响应处理。

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
- `GoogleWorkspaceLoginStart` 会把部署级 OAuth Client 自动注册到当前 `user_id` 的 gogcli 配置。
- 授权命令只请求基础服务：`--services gmail,drive,calendar,docs,sheets,slides`。
- 用户仍需在浏览器打开授权 URL 并点击 Allow。
- assisted callback 成功后，refresh token 加密保存到当前 user workspace 的 `/workspace/.config/gogcli/keyring/`。
- `GoogleWorkspaceAuthStatus(check=true)` 用于查看/验活当前 user 已绑账号。

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

- OpenClaw 源码：`/home/lake/workspace/openclaw`
