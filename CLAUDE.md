# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ripple** — Agentic System

## Repository

- Remote: https://github.com/echonoshy/ripple.git
- Branch: master
- Language: Python

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

