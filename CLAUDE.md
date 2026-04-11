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
  interfaces/          # 接口层
    cli/               # 命令行接口（Python）
    web/               # Web 前端（Next.js + TypeScript）
tests/                 # 测试文件
scripts/               # 辅助脚本
config/                # 配置文件
skills/                # 用户自定义 Skills（Markdown）
```

## 运行应用

### 后端 (Python)

```bash
# 交互式 CLI
uv run ripple cli

# 列出所有工具和技能
uv run python scripts/list_tools.py

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

Ripple 支持两种类型的 Skills：

### Bundled Skills（内置技能）
- **位置**: `src/ripple/skills/bundled/`
- **格式**: Python 文件，通过 `register_bundled_skill()` 注册
- **内容**: 硬编码的字符串常量（prompt）
- **示例**: `simplify.py`, `hello.py`
- **用途**: 编译到系统中的通用技能

### File-based Skills（文件技能）
- **位置**: `skills/` 目录
- **格式**: Markdown 文件，带 YAML frontmatter
- **内容**: 用户定义的任务模板
- **加载**: 自动从 `skills/` 目录递归加载
- **覆盖**: 可以覆盖同名的 bundled skills

详细文档: [docs/SKILLS.md](docs/SKILLS.md)

Skill frontmatter 字段: `name`, `description`, `arguments`, `allowed-tools`, `context`, `when-to-use`

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
- **registry.py**: Bundled skills 注册表
- **loader.py**: 加载 bundled skills 和文件系统 skills，支持去重和覆盖
- **executor.py**: 执行 skills（inline 和 fork 模式）
- **skill_tool.py**: SkillTool 包装器，作为工具暴露给模型

### 消息流 (`src/ripple/messages/`)
- **types.py**: 消息类型 (UserMessage, AssistantMessage, ToolUseBlock, ToolResultBlock)
- **utils.py**: 消息规范化以兼容 API (处理 LiteLLM 特性)

### API 集成 (`src/ripple/api/`)
- **client.py**: OpenRouterClient 封装 OpenAI 兼容 API
- **streaming.py**: 处理流式响应，在流式传输期间处理工具调用

### 接口层 (`src/interfaces/`)
- **cli/**: 命令行接口 (Python)
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

### 安全

**重要**: 检查未被 `.gitignore` 的文件中，不要包含 API key、token 等敏感信息。如果测试文件中用到了，测试完毕后请删除该测试文件，或者明显提示风险，不要通过 git 上传。

## 本地参考项目

- Claude Code 源码: `/home/lake/workspace/claude-code`
- OpenClaw 源码: `/home/lake/workspace/openclaw`