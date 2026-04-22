# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供代码库工作指南。

## 项目概述

**ripple** — 受 claude-code 启发的 Agent 系统，具有完整的 agentic loop、工具调用、Skill 系统和 Hook 验证。

## 仓库信息

- 远程仓库: https://github.com/echonoshy/ripple.git
- 分支: master
- 语言: Python 3.13+ (后端), TypeScript/React (前端)

## 项目结构

```
src/
  ripple/              # 核心库（Python）
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
  interfaces/          # 接口层
    server/            # FastAPI Server（沙箱服务端）
    web/               # Web 前端（Next.js + TypeScript）
tests/                 # 测试文件
scripts/               # 辅助脚本
config/                # 配置文件
skills/                # 共享 Skills（Markdown）
```

### User 沙箱层

沙箱（workspace + 凭证 + nsjail.cfg）以 **user_id** 为隔离单位，而非 session_id。一个 user 对应一个长期存在的 workspace，其下可开多个 session；同一 user 的多个 session 共享 workspace，通过 user 级 `asyncio.Lock` 保证工具调用互斥。

调用方通过 HTTP header `X-Ripple-User-Id: <uid>` 传入 user_id；缺失时回落到 `default`。user_id 合法字符集 `[a-zA-Z0-9_-]{1,64}`。ripple 不做身份鉴权——由上游业务系统保证 user_id 的有效性与隔离语义。

管理端点：
- `POST /v1/sandboxes` — 幂等为当前 user 创建 sandbox
- `GET /v1/sandboxes` — 返回当前 user sandbox 摘要（含 workspace 大小、session 数、环境就绪态）
- `DELETE /v1/sandboxes` — 销毁当前 user 的整个 sandbox；`default` user 禁止销毁（409）

### 运行时目录 `.ripple/`

由 Server 在首次运行时创建，不纳入版本控制：

```
.ripple/
├── logs/
│   └── ripple.log                   # 进程日志
├── sandboxes-cache/                 # 跨 user 共享的包缓存
│   ├── uv-cache/
│   ├── corepack-cache/
│   └── pnpm-store/                  # 可选
└── sandboxes/
    └── <user_id>/                   # user 级沙箱（长期存在）
        ├── workspace/               # user 持久工作区（跨 session 共享）
        ├── nsjail.cfg               # user 级沙箱配置
        ├── credentials/
        │   ├── feishu.json          # 可选：飞书凭证
        │   └── notion.json          # 可选：Notion Integration Token
        └── sessions/
            └── <session_id>/        # 每个 session 的运行时状态
                ├── meta.json        # 会话元数据
                ├── messages.jsonl   # 消息流水（唯一消息来源）
                ├── tasks.json       # TaskTool todo 列表
                └── task-outputs/    # AgentTool 后台任务输出
```

## 运行应用

### 后端 (Python)

```bash
# 启动 API Server
uv run ripple

# 带自动重载（开发模式）
uv run ripple --reload

# 运行测试
uv run pytest
```

### 前端 (Web)

```bash
cd src/interfaces/web

# 开发服务器
bun run dev          # http://localhost:8820

# 生产构建
bun run build
bun run start

# 代码检查和格式化
bun run lint         # 检查错误
bun run lint:fix     # 自动修复错误
bun run format       # 使用 Prettier 格式化代码
bun run format:check # 检查格式（不修改文件）
```

## 工具链

### Python

- **依赖管理**: uv (`uv sync`, `uv add <pkg>`, `uv run <cmd>`)
- **代码格式化**: `ruff format`
- **代码检查**: `ruff check` (使用 `ruff check --fix` 自动修复)
- **测试**: pytest (通过 `uv run pytest` 运行)
- **行宽限制**: 120 (在 pyproject.toml 中配置)

### 前端 (TypeScript/React)

- **包管理器**: bun (`bun install`, `bun add <pkg>`, `bun run <cmd>`)
- **代码检查**: ESLint 9 with Next.js config
- **代码格式化**: Prettier (推荐)
- **类型检查**: TypeScript 严格模式
- **框架**: Next.js 16.2.3, React 19.2.4

## 配置

- 所有配置文件存储在 `config/` 目录
- 配置文件使用 YAML 格式 (`.yaml`)
- 不要使用 `.env` 保存配置
- 主配置文件: `config/settings.yaml` (API keys, 模型设置, agent 参数)
- 前端配置: `src/interfaces/web/package.json`, `eslint.config.mjs`, `tsconfig.json`

## Skill 系统

Skills 是带 YAML frontmatter 的 Markdown 文件，定义特定领域的任务模板。

### 加载层级（后者覆盖前者）
1. **Shared Skills**: 来自 `skills.shared_dirs` 配置（默认 `skills/shared`），所有 session 可见
2. **Workspace Skills**: 来自每个 session 沙箱内的 `workspace/skills/`

### Skill 文件格式
- 文件名为 `SKILL.md`（推荐），或含 YAML frontmatter 且有 `name`/`description` 字段
- frontmatter 字段: `name`, `description`, `arguments`, `allowed-tools`, `context`, `when-to-use`

详细文档: [docs/SKILLS.md](docs/SKILLS.md)

## 架构

### 核心 Agent Loop (`src/ripple/core/`)
- **agent_loop.py**: 主查询循环 - 处理多轮对话、工具调用和完成检测
- **state.py**: QueryState 跟踪对话历史和轮次计数
- **context.py**: ToolUseContext 管理可用工具、会话信息和工作目录
- **transitions.py**: 状态机转换 (ContinueNextTurn, Terminal, ContinueStopHookBlocking)

### 工具系统 (`src/ripple/tools/`)
- **base.py**: BaseTool 抽象类 - 所有工具继承自此
- **orchestration.py**: 处理并发/串行工具执行
- **builtin/**: 内置工具 (Bash, Read, Write)

### Skill 系统 (`src/ripple/skills/`)
- **loader.py**: 加载 shared 和 workspace skills，支持 mtime 缓存
- **executor.py**: 执行 skills（inline 和 fork 模式）
- **skill_tool.py**: SkillTool 包装器，作为工具暴露给模型

### 消息流 (`src/ripple/messages/`)
- **types.py**: 消息类型 (UserMessage, AssistantMessage, ToolUseBlock, ToolResultBlock)
- **utils.py**: 消息规范化以兼容 API

### API 集成 (`src/ripple/api/`)
- **client.py**: OpenRouterClient 封装 OpenAI 兼容 API
- **streaming.py**: 处理流式响应，在流式传输期间处理工具调用

### 接口层 (`src/interfaces/`)
- **server/**: FastAPI Server 启动入口（`ripple` 命令，入口为 `interfaces.server.app:main`）
- **web/**: Web 前端 (Next.js + React)

## 编码规范

### Python (后端)

- **不要生成 `__init__.py`**: 除非模块确实需要包级别的导入/导出，否则不要创建 `__init__.py` 文件
- **代码完成后必须运行质量检查**: 每次修改 Python 代码后执行以下命令：
  ```bash
  ruff format .        # 格式化代码
  ruff check .         # 检查代码质量
  ruff check --fix .   # 自动修复问题（可选）
  ```
- **行宽限制 120**: Ruff 的 `line-length` 已配置为 120，所有代码应遵循此限制
- **优先使用内置类型注解**: 使用 `list[str]`、`dict[str, str]` 等，不要从 typing 导入 `List`、`Dict`、`Optional` 等
- **不要使用 `from __future__ import annotations`**
- **路径操作使用 pathlib**: 不要使用 `os.path` 或字符串拼接
- **不要使用环境变量语法**: 不使用 `os.getenv` 或 `os.environ`
- **异步优先**: 核心系统使用 async/await，工具执行是异步的

### TypeScript/React (前端)

- **代码完成后必须运行质量检查**: 每次修改前端代码后执行以下命令：
  ```bash
  cd src/interfaces/web
  bun run lint         # 检查 ESLint 错误
  bun run lint:fix     # 自动修复 ESLint 错误
  bun run format       # 格式化代码（Prettier）
  bun run format:check # 检查格式（不修改文件）
  ```
- **禁止使用 `any` 类型**: 必须明确指定类型，避免使用 `any`
- **React Hooks 规范**: 
  - 不要在 effect 中同步调用 setState
  - 遵循 React 官方 hooks 最佳实践
- **导入未使用的变量**: 及时清理未使用的导入
- **TypeScript 严格模式**: 项目已启用 `strict: true`，必须遵守严格类型检查

## 环境

### 网络代理

由于网络原因，如果你要测试、debug 或者启动该项目，先执行 `proxy_on`

### 外部 CLI 依赖

三个通过 `vendor/` 目录托管的静态二进制，沙箱启动时 readonly bind-mount 到 `/opt/<name>/`：

| CLI | 安装脚本 | 宿主安装位置 | 沙箱路径 | 鉴权方式 |
|-----|----------|-------------|----------|---------|
| `lark-cli`（飞书） | `bash scripts/install-feishu-cli.sh` | `vendor/lark-cli/v<X.Y.Z>/bin/` | `/opt/lark-cli/current/bin/lark-cli` | per-user：`lark-cli auth login`（OAuth），凭证落在 `sandboxes/<uid>/workspace/.lark-cli/` |
| `ntn`（Notion） | `bash scripts/install-notion-cli.sh` | `vendor/notion-cli/v<X.Y.Z>/bin/` | `/opt/notion-cli/current/bin/ntn` | per-user：用户对话粘贴 token → 模型调内置工具 `NotionTokenSet` → `sandboxes/<uid>/credentials/notion.json` → `NOTION_API_TOKEN` env |
| `gog`（gogcli, Google Suite CLI） | `bash scripts/install-gogcli-cli.sh` | `vendor/gogcli-cli/v<X.Y.Z>/bin/` | `/opt/gogcli-cli/current/bin/gog` | per-user 独立 GCP 项目 + **远程 2-step OAuth**：用户 GCP Console 建 Desktop OAuth Client → 粘 `client_secret.json` → `GoogleWorkspaceClientConfigSet` → `GoogleWorkspaceLoginStart` 拿 URL → 用户本地浏览器 Allow → 复制地址栏回调 URL → `GoogleWorkspaceLoginComplete` → 加密 refresh_token 存到 `/workspace/.config/gogcli/keyring/`（backend=file，密码由 ripple provision 时随机生成） |

- 下载失败都会打印手工安装指引，**不会自动重试**
- 版本切换：`bash scripts/use-<name>-cli.sh <version>`
- 相关 skill 分别在 `skills/lark/`、`skills/notion/`、`skills/gog/` 下（首次使用前必读对应 `*-shared/SKILL.md`）
- `gog` 的鉴权涉及两个独立状态：`has_gogcli_client_config`（OAuth Client 绑定）+ `has_gogcli_login`（远程 2-step 授权完成），前端 SettingsModal 分两个 badge 展示
- **`gog` 不要求 ripple server 和用户浏览器同机**（使用 `gog auth add --remote --step 1/2`，用户把浏览器地址栏 callback URL 贴回 agent 完成授权）
- 破坏性 gog 子命令（gmail send / drive delete / sheets clear / admin.* 等）**必须先调 `AskUser` 工具让用户显式确认**后才能通过 `Bash` 执行；详见 `skills/gog/gog-shared/SKILL.md`

### 安全

**重要**: 检查未被 `.gitignore` 的文件中，不要包含 API key、token 等敏感信息。如果测试文件中用到了，测试完毕后请删除该测试文件，或者明显提示风险，不要通过 git 上传。

## 本地参考项目

- Claude Code 源码: `/home/lake/workspace/claude-code`
- OpenClaw 源码: `/home/lake/workspace/openclaw`


## 参考行为

1. 遇到问题，不要上来就用正则这种方案， 这种取巧的方案，总会留下很多不靠谱的缺口。 好好想一下， 有没有妥善的方案呢？ 愤怒💢！