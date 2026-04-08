# Agent 工具文档

## 概述

Agent 工具是 Ripple 系统中用于启动子 agent 处理复杂任务的核心工具。它支持两种模式：

1. **Fork 模式**（默认）：子 agent 继承父 agent 的完整对话上下文
2. **SubAgent 类型模式**：指定专用 agent 类型，子 agent 有独立上下文（未实现）

## Fork 模式

### 核心特性

- **上下文继承**：子 agent 看到父 agent 的所有对话历史
- **Prompt Cache 共享**：所有 fork 子 agent 的 API 请求前缀字节级相同，节省成本
- **后台运行**：fork 子 agent 在后台异步执行，通过任务通知返回结果
- **防递归**：fork 子 agent 无法再次 fork，避免无限递归

### 使用方式

```python
# 基本用法（fork 模式）
{
  "name": "Agent",
  "input": {
    "description": "分析代码库",
    "prompt": "分析 src/ripple/core/ 目录下的所有文件，总结核心架构"
  }
}

# 指定模型
{
  "name": "Agent",
  "input": {
    "description": "快速搜索",
    "prompt": "搜索所有 TODO 注释",
    "model": "haiku"
  }
}
```

### 工作原理

1. **消息构建**：
   ```
   [父 agent 的历史消息]
   + [父 assistant 消息（包含所有 tool_use blocks）]
   + [user 消息（占位符 tool_results + 子任务指令）]
   ```

2. **占位符 tool_result**：
   - 所有 fork 子 agent 使用相同的占位符文本
   - 确保 API 请求前缀字节级相同
   - 最大化 prompt cache 命中率

3. **子任务指令**：
   - 包含 `<fork-boilerplate>` 标签（用于防递归）
   - 明确告知子 agent 的角色和规则
   - 要求结构化输出（Scope, Result, Key files, etc.）

### 输出格式

Fork 子 agent 启动后，返回任务信息：

```json
{
  "status": "fork_launched",
  "task_id": "task-abc123",
  "description": "分析代码库",
  "prompt": "分析 src/ripple/core/ 目录...",
  "output_file": ".ripple/tasks/task-abc123.txt"
}
```

任务完成后，会收到通知消息：

```
<task-notification>
Background task completed: 分析代码库

Task ID: task-abc123
Turns used: 5
Output file: .ripple/tasks/task-abc123.txt

Result:
Scope: 分析 src/ripple/core/ 目录的核心架构
Result: 核心模块包括 agent_loop.py（主循环）、state.py（状态管理）...
Key files: src/ripple/core/agent_loop.py, src/ripple/core/state.py
</task-notification>
```

## SubAgent 类型模式（未实现）

### 计划特性

- 指定专用 agent 类型（如 `explore`, `plan`）
- 每种类型有独立的系统提示和工具集
- 不继承父 agent 的对话历史

### 使用方式（计划）

```python
{
  "name": "Agent",
  "input": {
    "description": "探索代码库",
    "prompt": "找到所有 API 端点",
    "subagent_type": "explore"
  }
}
```

## 配置

在 `config/settings.yaml` 中配置：

```yaml
tools:
  agent:
    fork:
      enabled: true
      max_turns: 200
      output_dir: ".ripple/tasks"
    
    subagent_types:
      available:
        - explore
        - plan
        - general-purpose
```

## 防递归机制

Fork 子 agent 的消息中包含 `<fork-boilerplate>` 标签，Agent 工具会检测此标签：

```python
if is_in_fork_child(messages):
    return Error("Cannot fork from within a fork child")
```

这确保了：
- Fork 子 agent 无法再次调用 Agent 工具进行 fork
- 避免无限递归导致的资源耗尽

## 后台任务管理

### 任务生命周期

1. **创建**：`TaskManager.create_task()`
2. **启动**：`TaskManager.start_task()`
3. **运行**：异步执行 agent loop
4. **完成**：写入输出文件，发送通知

### 任务输出

所有任务输出保存在 `.ripple/tasks/` 目录：

```
.ripple/tasks/
  ├── task-abc123.txt
  ├── task-def456.txt
  └── ...
```

### 查看任务状态

```python
# 获取任务管理器
from ripple.core.background import get_task_manager

task_manager = get_task_manager()

# 列出所有任务
tasks = task_manager.list_tasks()

# 获取特定任务
task = task_manager.get_task("task-abc123")

# 等待任务完成
task = await task_manager.wait_for_task("task-abc123")
```

## 与 SubAgent 工具的对比

| 特性 | Agent Tool (Fork) | SubAgent Tool |
|------|-------------------|---------------|
| 上下文继承 | ✅ 完整继承 | ❌ 从零开始 |
| Prompt Cache | ✅ 共享 | ❌ 独立 |
| 后台运行 | ✅ 默认 | ❌ 同步等待 |
| 效率 | 🚀 高（复用上下文） | 🐢 低（冷启动） |
| Token 消耗 | 💰 低（cache 命中） | 💸 高（重复读取） |
| 适用场景 | 需要上下文的任务 | 完全独立的任务 |

## 最佳实践

### 何时使用 Fork 模式

- 需要基于当前对话上下文的任务
- 需要访问已读取的文件内容
- 需要理解已建立的项目知识
- 多个相关子任务并发执行

### 何时使用 SubAgent 模式（未来）

- 完全独立的任务（如搜索外部资源）
- 需要特定工具集的任务
- 不需要父 agent 上下文的任务

### 并发执行

Agent 工具是并发安全的，可以同时启动多个 fork 子 agent：

```python
[
  {"name": "Agent", "input": {"description": "分析模块 A", "prompt": "..."}},
  {"name": "Agent", "input": {"description": "分析模块 B", "prompt": "..."}},
  {"name": "Agent", "input": {"description": "分析模块 C", "prompt": "..."}}
]
```

所有子 agent 会并发执行，共享 prompt cache，显著提升效率。

## 故障排查

### 问题：Fork 子 agent 无法启动

**检查**：
- 是否在 fork 子 agent 中再次调用 Agent 工具？
- 查看错误消息："Cannot fork from within a fork child"

**解决**：
- Fork 子 agent 应该直接使用工具（Bash, Read, Write），而不是再次 fork

### 问题：任务输出文件不存在

**检查**：
- 任务是否已完成？查看 `task.status`
- 输出目录是否存在？默认为 `.ripple/tasks/`

**解决**：
- 等待任务完成：`await task_manager.wait_for_task(task_id)`
- 检查配置：`tools.agent.fork.output_dir`

### 问题：Fork 子 agent 行为异常

**检查**：
- 子 agent 是否遵循 fork boilerplate 的规则？
- 是否尝试对话或提问？

**解决**：
- Fork 子 agent 应该静默使用工具，最后一次性报告结果
- 检查系统提示是否正确注入

## 架构设计

### 核心模块

1. **`src/ripple/core/fork.py`**：
   - `build_forked_messages()`：构建 fork 消息
   - `is_in_fork_child()`：防递归检测
   - `build_child_message()`：构建子任务指令

2. **`src/ripple/core/background.py`**：
   - `TaskManager`：任务管理器
   - `BackgroundTask`：任务数据结构
   - `create_task_notification()`：创建通知消息

3. **`src/ripple/tools/builtin/agent_tool.py`**：
   - `AgentTool`：工具实现
   - `_run_fork_mode()`：fork 模式执行
   - `_run_subagent_mode()`：subagent 模式执行（未实现）

### 消息流

```
用户输入
  ↓
主 Agent Loop
  ↓
调用 Agent Tool
  ↓
构建 fork 消息（继承上下文）
  ↓
创建后台任务
  ↓
启动子 Agent Loop（异步）
  ↓
返回任务信息
  ↓
主 Agent 继续执行
  ↓
子 Agent 完成后发送通知
```

## 未来改进

1. **实现 SubAgent 类型模式**：
   - 加载 agent 定义文件
   - 支持自定义系统提示
   - 支持工具过滤

2. **增强任务管理**：
   - 任务取消功能
   - 任务优先级
   - 任务依赖关系

3. **改进通知机制**：
   - 实时进度更新
   - 流式输出
   - 错误详情

4. **Worktree 隔离**：
   - 支持在独立 git worktree 中运行
   - 避免文件冲突

## 参考

- [claude-code Fork 实现](https://github.com/anthropics/claude-code)
- [Ripple 架构文档](../CLAUDE.md)
- [消息系统文档](../src/ripple/messages/types.py)
