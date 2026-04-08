# Fork 机制实现总结

## 概述

成功实现了类似 claude-code 的 Fork 机制，替代了原有的 SubAgent 工具。

## 核心改进

### 1. 上下文继承
- **之前（SubAgent）**：子 agent 从零开始，没有父 agent 的上下文
- **现在（Fork）**：子 agent 继承父 agent 的完整对话历史

### 2. Prompt Cache 共享
- 所有 fork 子 agent 的 API 请求前缀字节级相同
- 使用相同的占位符 tool_result
- 最大化 cache 命中率，节省成本

### 3. 后台异步执行
- Fork 子 agent 在后台运行
- 通过任务通知机制返回结果
- 主 agent 可以继续执行其他任务

### 4. 防递归机制
- 通过 `<fork-boilerplate>` 标签检测
- Fork 子 agent 无法再次 fork
- 避免无限递归

## 实现的文件

### 核心模块

1. **`src/ripple/core/fork.py`** - Fork 核心逻辑
   - `build_forked_messages()`: 构建 fork 消息（继承上下文）
   - `is_in_fork_child()`: 防递归检测
   - `build_child_message()`: 构建子任务指令
   - `build_worktree_notice()`: Worktree 隔离通知

2. **`src/ripple/core/background.py`** - 后台任务管理
   - `TaskManager`: 任务管理器（创建、启动、等待、取消）
   - `BackgroundTask`: 任务数据结构
   - `create_task_notification()`: 创建任务通知消息

3. **`src/ripple/tools/builtin/agent_tool.py`** - Agent 工具
   - `AgentTool`: 工具实现
   - `_run_fork_mode()`: Fork 模式执行
   - `_run_subagent_mode()`: SubAgent 模式（未实现）

### 集成修改

4. **`src/interfaces/cli/main.py`** - CLI 入口
   - 替换 SubAgentTool 为 AgentTool
   - 传入消息历史以支持 fork 模式

5. **`src/interfaces/cli/interactive.py`** - 交互式 CLI
   - 替换 SubAgentTool 为 AgentTool
   - 传入消息历史以支持 fork 模式

### 配置和文档

6. **`config/settings.yaml.example`** - 配置示例
   - 添加 Agent 工具配置
   - Fork 模式参数（max_turns, output_dir）

7. **`docs/AGENT_TOOL.md`** - 完整文档
   - 使用指南
   - 工作原理
   - 与 SubAgent 对比
   - 最佳实践
   - 故障排查

8. **`tests/test_agent_tool.py`** - 测试文件
   - 9 个测试用例，全部通过
   - 覆盖核心功能

## 架构设计

### 消息构建流程

```
父 agent 的历史消息
  ↓
+ 父 assistant 消息（包含所有 tool_use blocks）
  ↓
+ user 消息：
  - 占位符 tool_results（所有 fork 子 agent 相同）
  - 子任务指令（每个子 agent 不同）
  ↓
发送给 API（前缀字节级相同，共享 cache）
```

### 后台任务流程

```
调用 Agent Tool
  ↓
创建 BackgroundTask
  ↓
启动异步任务（asyncio.create_task）
  ↓
返回任务信息给主 agent
  ↓
主 agent 继续执行
  ↓
子 agent 完成后发送通知
```

## 测试结果

所有 9 个测试用例通过：

1. ✅ `test_build_child_message` - 子任务指令构建
2. ✅ `test_build_forked_messages` - Fork 消息构建
3. ✅ `test_build_forked_messages_no_tool_use` - 无 tool_use 情况
4. ✅ `test_is_in_fork_child` - 防递归检测
5. ✅ `test_task_manager_create_task` - 任务创建
6. ✅ `test_task_manager_get_task` - 任务获取
7. ✅ `test_task_manager_list_tasks` - 任务列表
8. ✅ `test_create_task_notification` - 任务通知
9. ✅ `test_task_manager_run_task` - 任务运行（异步）

## 代码质量

- ✅ 通过 `ruff check`（无错误）
- ✅ 通过 `ruff format`（代码格式化）
- ✅ 类型注解完整
- ✅ 文档字符串完整

## 使用示例

### 基本用法（Fork 模式）

```python
{
  "name": "Agent",
  "input": {
    "description": "分析代码库",
    "prompt": "分析 src/ripple/core/ 目录下的所有文件，总结核心架构"
  }
}
```

### 并发执行

```python
[
  {"name": "Agent", "input": {"description": "分析模块 A", "prompt": "..."}},
  {"name": "Agent", "input": {"description": "分析模块 B", "prompt": "..."}},
  {"name": "Agent", "input": {"description": "分析模块 C", "prompt": "..."}}
]
```

所有子 agent 并发执行，共享 prompt cache。

## 与 SubAgent 的对比

| 特性 | Agent Tool (Fork) | SubAgent Tool |
|------|-------------------|---------------|
| 上下文继承 | ✅ 完整继承 | ❌ 从零开始 |
| Prompt Cache | ✅ 共享 | ❌ 独立 |
| 后台运行 | ✅ 默认 | ❌ 同步等待 |
| 效率 | 🚀 高（复用上下文） | 🐢 低（冷启动） |
| Token 消耗 | 💰 低（cache 命中） | 💸 高（重复读取） |

## 未来改进

1. **实现 SubAgent 类型模式**：
   - 支持 `subagent_type` 参数（explore, plan, general-purpose）
   - 加载 agent 定义文件
   - 自定义系统提示和工具集

2. **增强任务管理**：
   - 任务取消功能（已实现接口，待测试）
   - 任务优先级
   - 任务依赖关系

3. **改进通知机制**：
   - 实时进度更新
   - 流式输出
   - 错误详情

4. **Worktree 隔离**：
   - 支持在独立 git worktree 中运行
   - 避免文件冲突

## 迁移指南

### 从 SubAgent 迁移到 Agent Tool

**之前（SubAgent）**：
```python
{
  "name": "SubAgent",
  "input": {
    "prompt": "搜索所有 TODO 注释",
    "max_turns": 5,
    "allowed_tools": ["Read", "Grep"]
  }
}
```

**现在（Agent Tool - Fork 模式）**：
```python
{
  "name": "Agent",
  "input": {
    "description": "搜索 TODO",
    "prompt": "搜索所有 TODO 注释"
  }
}
```

**优势**：
- 不需要指定 `allowed_tools`（继承所有工具）
- 不需要指定 `max_turns`（使用配置默认值 200）
- 自动继承上下文，无需重新读取文件

## 配置

在 `config/settings.yaml` 中：

```yaml
tools:
  builtin:
    - agent  # 启用 Agent 工具

  agent:
    fork:
      enabled: true
      max_turns: 200
      output_dir: ".ripple/tasks"
```

## 运行测试

```bash
# 运行所有测试
uv run python tests/test_agent_tool.py

# 使用 pytest
uv run pytest tests/test_agent_tool.py -v
```

## 总结

成功实现了 Fork 机制，显著提升了子 agent 的效率和用户体验：

- **效率提升**：通过上下文继承和 prompt cache 共享，减少重复工作
- **成本降低**：减少 token 消耗，提高 cache 命中率
- **体验改善**：后台异步执行，主 agent 不被阻塞
- **安全性**：防递归机制避免无限循环

这是一个重要的架构改进，为 ripple 系统带来了更强大的多 agent 协作能力。
