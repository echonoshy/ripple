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

# 设置 API Key
export OPENROUTER_API_KEY="your-api-key"
```

### 基础使用

```bash
# 使用 CLI
uv run python -m ripple.cli.main "创建一个文件 /tmp/test.txt，内容是 Hello World"

# 运行测试
uv run python test_basic.py

# 测试 Skill 系统
uv run python test_skill.py
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

在 `.claude/skills/` 目录下创建 `.md` 文件：

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

## 🏗️ 架构

```
ripple/
├── core/           # 核心 Agent Loop
│   ├── agent_loop.py
│   ├── state.py
│   └── context.py
├── api/            # API 客户端
│   ├── client.py
│   └── streaming.py
├── tools/          # 工具系统
│   ├── base.py
│   ├── orchestration.py
│   └── builtin/
├── skills/         # Skill 系统
│   ├── loader.py
│   ├── executor.py
│   └── skill_tool.py
├── messages/       # 消息类型
└── utils/          # 工具函数
```

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
