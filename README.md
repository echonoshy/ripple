<div align="center">

<img src="src/interfaces/web/src/app/icon.svg" alt="Ripple Logo" width="120" />

# Ripple 涟漪

*让每个提问都成为涟漪的中心，每一次迭代都是向着解的蔓延。*

[![Python 3.13+](https://img.shields.io/badge/Python-3.13%2B-blue?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Status: WIP](https://img.shields.io/badge/Status-WIP-red?style=for-the-badge)](https://github.com/echonoshy/ripple)

**Ripple** 是一个受 [claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) 启发而构建的 Python Agent 系统。

⚠️ **注意：本项目目前处于快速开发（WIP）阶段，核心机制随时可能调整，功能尚不稳定。**

</div>

---

## 预览

<p align="center">
  <img src="assets/web.png" width="80%" alt="Ripple Web 界面" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />
</p>

## 文档

- [Agent 系统架构说明](https://echonoshy.github.io/ripple/pages/agent-system-architecture.html)

## 功能概览

- 完整的 agentic loop：支持多轮对话、工具调用和停止条件判断。
- 内置工具系统：包含 Bash、Read、Write、Skill、SubAgent 等工具。
- Skill 系统：通过 Markdown + YAML frontmatter 定义可复用的任务模板。
- Hook 与权限机制：用于工具调用前后的验证、拦截和授权。
- user 级沙箱：按 `user_id` 隔离长期 workspace，一个 user 可拥有多个 session。
- Web 界面：基于 Next.js + React 的交互式前端。

## 快速开始

### 环境要求

- Python 3.13+
- [uv](https://docs.astral.sh/uv/)
- [bun](https://bun.sh/)（仅运行 Web 前端时需要）
- nsjail（启用沙箱运行时需要）

### 1. 安装后端依赖

```bash
uv sync
```

### 2. 准备配置文件

项目不会提交真实密钥。先复制示例配置，再填入本地可用的 API key：

```bash
cp config/settings.yaml.sample config/settings.yaml
```

至少需要配置：

- `api.provider`：当前启用的模型 provider。
- `api.providers.<provider>.api_key`：对应 provider 的 API key。
- `server.api_keys`：访问 Ripple Server 的 API key。

`config/settings.yaml` 已被 `.gitignore` 忽略，请不要提交包含真实密钥的配置文件。

### 3. 启动后端服务

```bash
uv run ripple
```

开发时可启用自动重载：

```bash
uv run ripple --reload
```

默认服务地址为：

```text
http://localhost:8810
```

### 4. 启动 Web 前端

```bash
cd src/interfaces/web
bun install
bun run dev
```

默认前端地址为：

```text
http://localhost:8820
```

## 基础使用

### 多用户沙箱

Ripple Server 通过 HTTP Header 区分 user：

```http
X-Ripple-User-Id: <uid>
```

如果没有传入该 Header，会回落到 `default` user。`user_id` 只允许使用：

```text
[a-zA-Z0-9_-]{1,64}
```

同一个 user 的多个 session 共享同一个长期 workspace，并通过 user 级锁保证工具调用互斥。

### 沙箱管理端点

- `POST /v1/sandboxes`：为当前 user 幂等创建 sandbox。
- `GET /v1/sandboxes`：查看当前 user 的 sandbox 摘要。
- `DELETE /v1/sandboxes`：销毁当前 user 的 sandbox；`default` user 禁止销毁。

### 运行时目录

服务首次运行后会创建 `.ripple/`，该目录不应提交：

```text
.ripple/
├── logs/
├── sandboxes-cache/
└── sandboxes/
```

其中 `.ripple/sandboxes/<user_id>/workspace/` 是 user 级持久工作区，多个 session 会共享它。

## 项目结构

```text
src/
  ripple/              # Python 核心库
    core/              # Agent Loop 核心
    api/               # API 客户端
    tools/             # 工具系统
    skills/            # Skill 系统
    hooks/             # Hook 系统
    messages/          # 消息类型
    permissions/       # 权限管理
    sandbox/           # nsjail 沙箱管理
    compact/           # 上下文压缩
    tasks/             # 后台任务管理
  interfaces/
    server/            # FastAPI Server
    web/               # Next.js + React 前端
tests/                 # 测试
scripts/               # 辅助脚本
config/                # 配置文件
skills/                # 共享 Skills
```

## Skill 系统

Skills 是带 YAML frontmatter 的 Markdown 文件，用于定义特定领域的任务模板。

加载层级：

1. Shared Skills：来自 `skills.shared_dirs` 配置，默认 `skills/*`。
2. Workspace Skills：来自每个 user workspace 内的 `skills/`。

详细说明见 [docs/SKILLS.md](docs/SKILLS.md)。

## 开发命令

### 后端

```bash
uv run pytest
uv run ruff format .
uv run ruff check .
```

### 前端

```bash
cd src/interfaces/web
bun run lint
bun run format:check
bun run build
```

## 配置说明

主配置文件为 `config/settings.yaml`，示例文件为 `config/settings.yaml.sample`。

配置包含：

- `api`：provider、API key、base URL、超时与重试。
- `model`：默认模型、输出 token、模型别名。
- `agent`：最大轮次和 session 前缀。
- `tools`：启用的内置工具与 SubAgent 配置。
- `logging`：日志级别、轮转和保留策略。
- `server`：HTTP 地址、访问密钥和沙箱配置。
- `services`：第三方服务配置。
- `skills`：共享 Skill 目录。

## 注意事项

- 本项目仍处于 WIP 阶段，接口和配置可能变化。
- 不要提交 `config/settings.yaml`、`.ripple/` 或任何包含 token/API key 的文件。
- 如果需要测试或调试依赖网络的功能，请先确认本机网络代理配置可用。


<br/>

<div align="center">
<sub>Built with ❤️ by echonoshy</sub>
</div>
