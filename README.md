<div align="center">

# 🌊 Ripple

**让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。**

[![Python 3.13+](https://img.shields.io/badge/Python-3.13%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-echonoshy%2Fripple-181717?logo=github)](https://github.com/echonoshy/ripple)

Ripple 是一个基于 Python 的 Agent 系统，灵感来自 [claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)，实现了完整的 agentic loop，支持工具调用、Skill 系统和 Hook 验证。

</div>

---

## ✨ 特性

| 特性 | 描述 |
|------|------|
| 🔄 **Agent Loop** | 多轮对话，自动工具调用，智能任务完成判断 |
| 🛠️ **工具系统** | 并发 / 串行执行，易于扩展（Bash、Read、Write、Search、SubAgent...） |
| 📚 **Skill 系统** | 通过 Markdown + YAML frontmatter 定义可复用技能 |
| 🤖 **SubAgent** | 支持 Fork / 专业模式启动子 Agent，处理复杂多步任务 |
| 🔍 **Web Search** | 内置 DuckDuckGo 搜索工具，实时获取信息 |
| 🔌 **多模型支持** | 通过 OpenRouter 接入 Claude Opus / Sonnet / Haiku 等模型 |
| ⚡ **异步架构** | 基于 async/await 的高性能异步 I/O |
| 💬 **交互式 CLI** | 基于 Rich + Prompt Toolkit 的美观终端体验 |

## 📸 演示

### Case 1 — CLI 界面 & 信息搜索

> 启动 Ripple CLI，使用 `/history`、`/log` 等命令管理会话，通过自然语言提问触发 Web Search 工具自动搜索并整理信息。

<p align="center">
  <img src="assets/case-1.png" width="820" alt="Ripple CLI 界面与信息搜索演示" />
</p>

### Case 2 — Skill 系统调用

> 通过自然语言触发自定义 Skill（`fengge-wangmingtianya-perspective`），Agent 自动匹配并执行对应的角色扮演技能，生成富有特色的回复。

<p align="center">
  <img src="assets/case-2.png" width="820" alt="Ripple Skill 系统调用演示" />
</p>

## 🚀 快速开始

### 安装

```bash
git clone https://github.com/echonoshy/ripple.git
cd ripple

# 安装依赖（使用 uv）
uv sync

# 配置 API Key — 编辑 config/settings.yaml
# api:
#   api_key: "your-api-key-here"
```

### 运行

```bash
# 交互式终端（推荐）
uv run ripple cli

# 单次命令
uv run ripple run "创建一个文件 /tmp/test.txt，内容是 Hello World"

# 查看所有工具和 Skills
uv run python scripts/list_tools.py

# 运行测试
uv run pytest
```

## 💻 交互式 CLI

```bash
uv run ripple cli
```

**终端命令：**

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清空会话历史 |
| `/tokens` | 显示 Token 使用情况 |
| `/model <name>` | 切换模型（支持别名：`opus` / `sonnet` / `haiku`） |
| `/models` | 查看可用模型列表 |
| `/thinking` | 开关思考模式 |
| `/info` | 显示当前配置 |
| `/log` | 显示日志文件位置 |
| `/history` | 查看历史会话记录 |
| `/exit` `/quit` | 退出 |

## 🛠️ 内置工具

| 工具 | 说明 |
|------|------|
| **Bash** | 执行 Shell 命令 |
| **Read** | 读取文件（支持分页、行号范围） |
| **Write** | 写入 / 创建文件 |
| **Search** | DuckDuckGo 搜索引擎，实时获取网络信息 |
| **AskUser** | 向用户提问并获取输入 |
| **Agent** | 启动 SubAgent 处理子任务 |
| **Skill** | 执行用户定义的 Skill |

## 📚 Skill 系统

Ripple 支持两种 Skill 类型：

### Bundled Skills（内置技能）

位于 `src/ripple/skills/bundled/`，通过 Python 代码注册，编译到系统中。

### File-based Skills（文件技能）

在 `skills/` 目录下创建 `.md` 文件，带 YAML frontmatter：

```markdown
---
name: hello
description: Say hello to someone
arguments: [name]
allowed-tools:
  - Write
---

# Hello Skill

Hello, $NAME! Welcome to Ripple.
```

文件技能会自动从 `skills/` 目录递归加载，同名时覆盖 bundled skills。

## ⚙️ 配置

所有配置存放在 `config/settings.yaml`：

```yaml
api:
  api_key: "your-api-key-here"
  base_url: "https://openrouter.ai/api/v1"

model:
  default: "anthropic/claude-sonnet-4.6"
  max_tokens: 4096
  temperature: 1.0

agent:
  max_turns: 10
```

## 🏗️ 项目架构

```
src/
├── ripple/                # 核心库
│   ├── core/              # Agent Loop（agent_loop / state / context / transitions）
│   ├── api/               # API 客户端 & 流式响应处理
│   ├── tools/             # 工具系统（base / orchestration / builtin/）
│   ├── skills/            # Skill 系统（registry / loader / executor / skill_tool）
│   ├── hooks/             # Hook 验证系统
│   ├── messages/          # 消息类型 & 归一化
│   ├── utils/             # 工具函数（config / conversation_log）
│   └── permissions/       # 权限管理
└── interfaces/            # 接口层
    └── cli/               # 命令行接口（main / interactive）

skills/                    # 用户自定义 Skill（Markdown + YAML frontmatter）
config/                    # 配置文件（settings.yaml）
tests/                     # 测试
scripts/                   # 辅助脚本
```

**代码规模**: 38 个 Python 模块，5500+ 行代码

## 🧑‍💻 开发

```bash
# 格式化
uv run ruff format

# 代码检查
uv run ruff check

# 自动修复
uv run ruff check --fix

# 运行测试
uv run pytest
```

## 📄 License

[MIT](https://opensource.org/licenses/MIT)
