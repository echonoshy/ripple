<div align="center">

<img src="assets/icon.png" alt="Ripple Logo" width="120" />

# Ripple 涟漪

*让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。*

[![Python 3.13+](https://img.shields.io/badge/Python-3.13%2B-blue?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-echonoshy%2Fripple-181717?style=for-the-badge&logo=github)](https://github.com/echonoshy/ripple)

**Ripple** 是一个基于 Python 的 Agent 系统，灵感源自 [claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)。<br>
它实现了完整的 Agentic Loop，并提供强大的工具调用、Skill 系统和 Hook 验证机制。

</div>

---

## ✨ 核心特性 (Features)

- 🔄 **Agent Loop**：支持多轮对话、自动工具调用与智能任务完成判断。
- 🛠️ **可扩展工具系统**：支持并发与串行执行，内置 Bash、Read、Write、Search、SubAgent 等基础能力。
- 📚 **Skill 系统**：通过 Markdown + YAML Frontmatter 轻松定义和复用专属技能。
- 🤖 **SubAgent 机制**：支持 Fork 与专业模式启动子 Agent，从容应对复杂多步任务。
- 🔍 **Web Search**：内置 DuckDuckGo 搜索，赋予 Agent 实时获取网络信息的能力。
- 🔌 **多模型无缝切换**：通过 OpenRouter 轻松接入 Claude Opus / Sonnet / Haiku 等前沿模型。
- ⚡ **高性能异步架构**：底层全面基于 `async/await` 实现高效的异步 I/O。
- 💬 **沉浸式交互 CLI**：基于 Rich + Prompt Toolkit 打造的美观、流畅的终端体验。

## 📸 演示 (Showcase)

### 场景一：CLI 界面 & 实时信息搜索

> 启动 Ripple CLI，使用 `/history`、`/log` 等命令管理会话。通过自然语言提问，触发 Web Search 工具自动搜索并整理信息。

<p align="center">
  <img src="assets/case-1.png" width="100%" alt="Ripple CLI 界面与信息搜索演示" />
</p>

### 场景二：Skill 系统深度调用

> 通过自然语言触发自定义 Skill（如 `fengge-wangmingtianya-perspective`），Agent 将自动匹配并执行对应的角色扮演技能，生成极具特色的专属回复。

<p align="center">
  <img src="assets/case-2.png" width="100%" alt="Ripple Skill 系统调用演示" />
</p>

## 🚀 快速开始 (Quick Start)

### 1. 安装

```bash
git clone https://github.com/echonoshy/ripple.git
cd ripple

# 使用 uv 安装依赖
uv sync
```

### 2. 配置

编辑 `config/settings.yaml` 文件，填入你的 API Key：

```yaml
api:
  api_key: "your-api-key-here"
  base_url: "https://openrouter.ai/api/v1"
```

### 3. 运行

```bash
# 启动交互式终端
uv run ripple cli

# 查看所有可用工具和 Skills
uv run python scripts/list_tools.py

# 运行测试用例
uv run pytest
```

## 💻 交互式 CLI (Interactive CLI)

启动 CLI：`uv run ripple cli`

**常用终端命令：**

| 命令 | 说明 |
| :--- | :--- |
| `/help` | 显示帮助信息 |
| `/clear` | 清空当前会话历史 |
| `/tokens` | 显示 Token 使用统计 |
| `/model <name>` | 切换模型（支持别名：`opus` / `sonnet` / `haiku`） |
| `/models` | 查看所有可用模型列表 |
| `/thinking` | 开启/关闭思考模式 |
| `/info` | 显示当前系统配置 |
| `/log` | 显示日志文件所在位置 |
| `/history` | 查看历史会话记录 |
| `/exit` 或 `/quit` | 退出系统 |

## 🛠️ 内置工具 (Built-in Tools)

| 工具名称 | 功能说明 |
| :--- | :--- |
| **Bash** | 执行 Shell 命令，与系统底层交互 |
| **Read** | 读取文件内容（支持分页、指定行号范围） |
| **Write** | 写入或创建新文件 |
| **Search** | 调用 DuckDuckGo 搜索引擎，实时获取网络信息 |
| **AskUser** | 主动向用户提问并获取输入 |
| **Agent** | 启动 SubAgent 处理复杂的子任务 |
| **Skill** | 执行用户自定义的 Skill |

## 📚 Skill 系统 (Skill System)

Ripple 提供了极其灵活的 Skill 机制，支持以下两种类型：

### Bundled Skills（内置技能）
位于 `src/ripple/skills/bundled/`，通过 Python 代码硬编码注册，随系统一同编译加载。

### File-based Skills（文件技能）
在 `skills/` 目录下创建 `.md` 文件，并通过 YAML Frontmatter 进行配置：

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
*注：系统会自动从 `skills/` 目录递归加载文件技能；若与内置技能同名，则优先使用文件技能。*

## ⚙️ 配置指南 (Configuration)

系统的所有核心配置均存放在 `config/settings.yaml` 中：

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

## 🏗️ 项目架构 (Architecture)

```text
src/
├── ripple/                # 核心库
│   ├── core/              # Agent Loop (状态机 / 上下文 / 转换逻辑)
│   ├── api/               # API 客户端与流式响应处理
│   ├── tools/             # 工具系统 (基础类 / 编排逻辑 / 内置工具)
│   ├── skills/            # Skill 系统 (注册表 / 加载器 / 执行器)
│   ├── hooks/             # Hook 验证系统
│   ├── messages/          # 消息类型与数据归一化
│   ├── utils/             # 工具函数 (配置解析 / 日志记录)
│   └── permissions/       # 权限管理模块
└── interfaces/            # 接口层
    └── cli/               # 命令行接口 (主入口 / 交互逻辑)

skills/                    # 用户自定义 Skill (Markdown + YAML)
config/                    # 配置文件目录
tests/                     # 测试用例
scripts/                   # 辅助脚本
```
*当前代码规模：38 个 Python 模块，约 5500+ 行代码。*

## 🧑‍💻 开发者指南 (Development)

```bash
# 代码格式化
uv run ruff format

# 代码静态检查
uv run ruff check

# 自动修复常见问题
uv run ruff check --fix

# 运行全量测试
uv run pytest
```

## 📄 开源协议 (License)

本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源。
