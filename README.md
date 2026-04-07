# Ripple

> 让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。

Ripple 是一个基于 Python 的 Agent 系统，灵感来自 claude-code，实现了完整的 agentic loop，支持工具调用、Skill 系统和 Hook 验证。

## ✨ 特性

- 🔄 **完整的 Agent Loop** - 多轮对话，自动工具调用，智能任务完成判断
- 🛠️ **工具系统** - 并发/串行执行，易于扩展
- 📚 **Skill 系统** - 通过 Markdown 定义可复用命令
- 🔌 **OpenRouter 集成** - 支持多种 AI 模型
- ⚡ **异步架构** - 高性能异步 I/O

## 🚀 快速开始

### 安装

```bash
# 克隆仓库
git clone https://github.com/echonoshy/ripple.git
cd ripple

# 安装依赖（使用 uv）
uv sync

# 配置 API Key
# 编辑 config/settings.yaml，设置你的 API Key
# api:
#   api_key: "your-api-key-here"
```

### 基础使用

```bash
# 使用交互式终端（推荐）
uv run ripple repl

# 使用单次命令 CLI
uv run ripple run "创建一个文件 /tmp/test.txt，内容是 Hello World"

# 查看所有工具和 Skills
uv run python scripts/list_tools.py

# 运行测试
uv run pytest
```

### 编程使用

```python
import asyncio
from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool
from ripple.skills.skill_tool import SkillTool

async def main():
    # 初始化工具
    tools = [BashTool(), ReadTool(), WriteTool(), SkillTool()]
    
    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(tools=tools),
        session_id="my-session",
        cwd=".",
    )
    
    # 创建客户端
    client = OpenRouterClient()
    
    # 执行查询
    async for item in query(
        user_input="你的问题",
        context=context,
        client=client,
        max_turns=10,
    ):
        if hasattr(item, "type") and item.type == "assistant":
            print(item.message)

asyncio.run(main())
```

## 📚 Skill 系统

Skill 是通过 Markdown 文件定义的可复用命令。

### 创建 Skill

在 `skills/` 目录下创建 `.md` 文件：

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

### 使用 Skill

```python
# 模型会自动调用 Skill Tool
"使用 hello skill 向 World 打招呼"
```

## 🛠️ 内置工具

- **Bash** - 执行 shell 命令
- **Read** - 读取文件（支持分页）
- **Write** - 写入文件
- **Skill** - 执行用户定义的 Skill

运行 `uv run python scripts/list_tools.py` 查看所有可用工具和 Skills。

## 💻 交互式终端

Ripple 提供了一个交互式 REPL 终端，支持多轮对话：

```bash
uv run python -m interfaces.cli.repl
```

**终端命令：**
- `/help` - 显示帮助
- `/clear` - 清空屏幕
- `/model <name>` - 切换模型
- `/info` - 显示当前配置
- `/exit` 或 `/quit` - 退出

## ⚙️ 配置

所有配置都在 `config/settings.yaml` 文件中：

```yaml
# API 配置
api:
  api_key: "your-api-key-here"
  base_url: "https://openrouter.ai/api/v1"

# 模型配置
model:
  default: "anthropic/claude-3.5-sonnet"
  max_tokens: 4096
  temperature: 1.0

# Agent 配置
agent:
  max_turns: 10
```

## 🏗️ 架构

```
src/
├── ripple/           # 核心库
│   ├── core/         # Agent Loop 核心
│   ├── api/          # API 客户端
│   ├── tools/        # 工具系统
│   ├── skills/       # Skill 系统
│   ├── hooks/        # Hook 系统
│   ├── messages/     # 消息类型
│   └── utils/        # 工具函数
└── interfaces/       # 接口层
    ├── cli/          # 命令行接口
    ├── server/       # HTTP/WebSocket (预留)
    └── web/          # Web 前端 (预留)
```

详细说明请查看 [STRUCTURE.md](STRUCTURE.md)

## 📊 项目状态

- ✅ Phase 1: 基础设施
- ✅ Phase 2: 核心 Agent Loop
- ✅ Phase 3: 工具系统
- ✅ Phase 4: Skill 系统
- ⏳ Phase 5: Hook 系统（部分完成）
- ⏳ Phase 6: 高级特性（待实现）

**代码统计**: 21 个 Python 文件，2500+ 行代码

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
