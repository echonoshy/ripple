# AGENTS.md

本文件为 OpenAI Codex / Codex CLI 提供项目工作指南。

## 优先级

- 用户当前请求和系统/开发者指令优先级最高。
- 本文件是 Codex 的项目入口；通用项目背景、架构、命令和编码规范继承 `CLAUDE.md`。
- 如果 `AGENTS.md` 与 `CLAUDE.md` 冲突，以 `AGENTS.md` 为准，并在必要时同步更新 `CLAUDE.md`。

## 项目速览

**ripple** 是受 claude-code 启发的 Agent 系统，包含 agentic loop、工具调用、Skill 系统、Hook 验证、FastAPI Server 和 Next.js Web 前端。

主要目录：

- `src/ripple/`：Python 核心库
- `src/interfaces/server/`：FastAPI Server
- `src/interfaces/web/`：Next.js + TypeScript 前端
- `skills/`：共享 Skill
- `tests/`：pytest 测试
- `config/`：YAML 配置

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
- 工作树可能已有用户改动；不要回滚与当前任务无关的改动。

## gog / Google Workspace 当前约定

`gog` 是通过 `vendor/gogcli-cli/` 托管的 Google Suite CLI，沙箱内路径为：

```text
/opt/gogcli-cli/current/bin/gog
```

当前只保留基础 Workspace 服务：

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

首次使用任何 gog 能力前，必须先读 `skills/gog/gog-shared/SKILL.md`。

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

## 本地参考项目

- Claude Code 源码：`/home/lake/workspace/claude-code`
- OpenClaw 源码：`/home/lake/workspace/openclaw`

