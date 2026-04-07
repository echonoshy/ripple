# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ripple** — Agent system inspired by claude-code with complete agentic loop, tool calling, Skill system, and Hook validation.

## Project Structure

```
src/
  ripple/              # 核心库
    core/              # Agent Loop 核心
    api/               # API 客户端
    tools/             # 工具系统
    skills/            # Skill 系统
    hooks/             # Hook 系统
    messages/          # 消息类型
    utils/             # 工具函数
    permissions/       # 权限管理
  interfaces/          # 接口层（所有用户界面）
    cli/               # 命令行接口
    server/            # HTTP/WebSocket 服务端（预留）
    web/               # Web 前端（预留）
tests/                 # 测试文件
scripts/               # 辅助脚本
config/                # 配置文件
```

## Repository

- Remote: https://github.com/echonoshy/ripple.git
- Branch: master
- Language: Python 3.13+

## Running the Application

```bash
# Interactive CLI (recommended)
uv run ripple cli

# Single command
uv run ripple run "your query"

# List all tools and skills
uv run python scripts/list_tools.py

# Run tests
uv run pytest
```

## Tooling

- **Dependency management**: uv (`uv sync`, `uv add <pkg>`, `uv run <cmd>`)
- **Formatting**: `ruff format`
- **Linting**: `ruff check` (use `ruff check --fix` for auto-fix)
- **Testing**: pytest (run via `uv run pytest`)
- **Line length**: 120 (configured in pyproject.toml via `[tool.ruff]`)

## Configuration

- All configuration files are stored in the `config/` directory
- Use YAML format (`.yaml`) for configuration files
- Do not use `.env` to save the config
- Main config: `config/settings.yaml` (API keys, model settings, agent parameters)

## Architecture

### Core Agent Loop (`src/ripple/core/`)

- **agent_loop.py**: Main query loop - handles multi-turn conversations, tool calling, and completion detection
- **state.py**: QueryState tracks conversation history and turn count
- **context.py**: ToolUseContext manages available tools, session info, and working directory
- **transitions.py**: State machine transitions (ContinueNextTurn, Terminal, ContinueStopHookBlocking)

### Tool System (`src/ripple/tools/`)

- **base.py**: BaseTool abstract class - all tools inherit from this
- **orchestration.py**: Handles concurrent/serial tool execution
- **builtin/**: Built-in tools (Bash, Read, Write)
- Tools are registered in ToolOptions and executed via orchestration layer

### Skill System (`src/ripple/skills/`)

- Skills are Markdown files in `skills/` directory
- **loader.py**: Discovers and loads skill definitions from frontmatter
- **executor.py**: Executes skills by substituting arguments into templates
- **skill_tool.py**: SkillTool wraps the skill system as a callable tool
- Skill frontmatter: `name`, `description`, `arguments`, `allowed-tools`

### Message Flow (`src/ripple/messages/`)

- **types.py**: Message types (UserMessage, AssistantMessage, ToolUseBlock, ToolResultBlock)
- **utils.py**: Message normalization for API compatibility (handles LiteLLM quirks)
- Messages flow: User → API → Assistant (with tool_use) → Tool execution → Tool results → API → ...

### API Integration (`src/ripple/api/`)

- **client.py**: OpenRouterClient wraps OpenAI-compatible API
- **streaming.py**: Processes streaming responses, handles tool calls during streaming

### Interface Layer (`src/interfaces/`)

- **cli/**: Command-line interface (main.py, interactive.py)
- **server/**: HTTP/WebSocket server (预留)
- **web/**: Web frontend (预留)

## Coding Conventions

### Python

- **不要生成 `__init__.py`**: 除非模块确实需要包级别的导入/导出，否则不要创建 `__init__.py` 文件。
- **使用 pyrootutils**: 通过 pyrootutils 管理项目根路径和模块导入。
- **代码完成后必须运行 ruff check**: 每次修改代码后执行 `ruff check` 和 `ruff format` 确保代码质量。
- **行宽限制 120**: Ruff 的 `line-length` 已配置为 120，所有代码应遵循此限制。
- **优先使用内置类型注解**: 使用 `list[str]`、`dict[str, str]` 等，不要从 typing 导入 `List`、`Dict`、`Optional` 等。
- **不要使用 `from __future__ import annotations`**。
- **路径操作使用 pathlib**: 不要使用 `os.path` 或字符串拼接。
- **不要使用环境变量语法**: 不使用 `os.getenv` 或 `os.environ`。
- **测试用例使用 `if __name__ == "__main__":` 模式**。
- **异步优先**: 核心系统使用 async/await，工具执行是异步的。

