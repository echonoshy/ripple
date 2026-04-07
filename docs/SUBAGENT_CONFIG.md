# SubAgent 工具配置指南

SubAgent 工具允许主 agent 启动子 agent 来处理复杂的子任务。本文档说明如何配置 SubAgent 工具。

## 配置文件位置

`config/settings.yaml`

## 配置项说明

```yaml
tools:
  # 启用的内置工具
  builtin:
    - bash
    - read
    - write
    - subagent  # 启用 SubAgent 工具
    - skill

  # SubAgent 工具配置
  subagent:
    # 默认最大轮数
    default_max_turns: 5

    # 默认允许的工具列表（为空则允许所有工具，除了 SubAgent 本身）
    # 示例: ["Read", "Bash", "Grep", "Glob"]
    default_allowed_tools: []

    # 子 agent 的权限模式
    # - "allow": 自动批准所有工具调用（推荐）
    # - "ask": 每次工具调用都询问用户
    # - "deny": 拒绝所有工具调用
    permission_mode: "allow"
```

## 配置项详解

### `default_max_turns`

子 agent 的默认最大轮数。

- **类型**: 整数
- **默认值**: 5
- **说明**: 限制子 agent 的执行轮数，防止无限循环
- **建议**: 
  - 简单任务: 3-5 轮
  - 复杂任务: 10-15 轮

### `default_allowed_tools`

子 agent 默认允许使用的工具列表。

- **类型**: 字符串数组
- **默认值**: `[]` (空数组，表示允许所有工具)
- **说明**: 
  - 为空时，子 agent 可以使用所有工具（除了 SubAgent 本身，防止递归）
  - 指定工具名称后，子 agent 只能使用列表中的工具
- **示例**:
  ```yaml
  # 只允许读取和搜索
  default_allowed_tools: ["Read", "Grep", "Glob"]
  
  # 允许读写和执行命令
  default_allowed_tools: ["Read", "Write", "Bash"]
  
  # 允许所有工具
  default_allowed_tools: []
  ```

### `permission_mode`

子 agent 的权限模式。

- **类型**: 字符串
- **默认值**: `"allow"`
- **可选值**:
  - `"allow"`: 自动批准所有工具调用（推荐）
  - `"ask"`: 每次工具调用都询问用户
  - `"deny"`: 拒绝所有工具调用
- **说明**: 
  - 推荐使用 `"allow"`，因为子 agent 的工具已经受到 `allowed_tools` 限制
  - 使用 `"ask"` 会导致频繁的用户交互
  - `"deny"` 仅用于调试

## 使用示例

### 示例 1: 使用默认配置

```yaml
tools:
  subagent:
    default_max_turns: 5
    default_allowed_tools: []
    permission_mode: "allow"
```

模型调用：
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Find all TODO comments in the codebase"
  }
}
```

结果：子 agent 使用默认配置（5 轮，所有工具）

### 示例 2: 限制工具权限

```yaml
tools:
  subagent:
    default_max_turns: 5
    default_allowed_tools: ["Read", "Grep", "Glob"]
    permission_mode: "allow"
```

模型调用：
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Search for error handling patterns"
  }
}
```

结果：子 agent 只能使用 Read、Grep、Glob 工具

### 示例 3: 运行时覆盖配置

```yaml
tools:
  subagent:
    default_max_turns: 5
    default_allowed_tools: ["Read", "Grep"]
    permission_mode: "allow"
```

模型调用：
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Analyze and fix the bug in auth.py",
    "max_turns": 10,
    "allowed_tools": ["Read", "Write", "Bash"]
  }
}
```

结果：子 agent 使用运行时指定的配置（10 轮，Read/Write/Bash 工具）

## 安全建议

### 1. 限制工具权限

对于不受信任的输入，建议限制子 agent 的工具权限：

```yaml
default_allowed_tools: ["Read", "Grep", "Glob"]  # 只读工具
```

### 2. 限制最大轮数

防止子 agent 无限循环：

```yaml
default_max_turns: 5  # 限制为 5 轮
```

### 3. 权限模式

生产环境推荐使用 `"allow"` 模式，但确保 `allowed_tools` 配置正确：

```yaml
permission_mode: "allow"
default_allowed_tools: ["Read", "Grep", "Glob"]  # 限制工具范围
```

## 防递归机制

SubAgent 工具内置防递归机制：

- 子 agent 的工具列表中**自动移除** SubAgent 工具
- 即使配置中包含 SubAgent，子 agent 也无法再创建子 agent
- 这是硬编码的安全机制，无法通过配置禁用

## 常见配置场景

### 场景 1: 代码分析任务

```yaml
tools:
  subagent:
    default_max_turns: 10
    default_allowed_tools: ["Read", "Grep", "Glob"]
    permission_mode: "allow"
```

适用于：代码搜索、结构分析、文档查找

### 场景 2: 自动化修复任务

```yaml
tools:
  subagent:
    default_max_turns: 15
    default_allowed_tools: ["Read", "Write", "Bash"]
    permission_mode: "allow"
```

适用于：Bug 修复、代码重构、自动化脚本

### 场景 3: 受限环境

```yaml
tools:
  subagent:
    default_max_turns: 3
    default_allowed_tools: ["Read"]
    permission_mode: "allow"
```

适用于：只读查询、安全审计

## 故障排查

### 问题 1: 子 agent 无法使用某个工具

**原因**: `allowed_tools` 配置中未包含该工具

**解决**:
```yaml
default_allowed_tools: ["Read", "Write", "YourTool"]
```

### 问题 2: 子 agent 执行轮数不足

**原因**: `default_max_turns` 设置过小

**解决**:
```yaml
default_max_turns: 10  # 增加轮数
```

或在调用时覆盖：
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "...",
    "max_turns": 15
  }
}
```

### 问题 3: 子 agent 工具调用被拒绝

**原因**: `permission_mode` 设置为 `"deny"` 或 `"ask"`

**解决**:
```yaml
permission_mode: "allow"
```

## 性能优化

### 1. 并发执行

SubAgent 工具支持并发执行，多个子 agent 可以同时运行：

```python
# 主 agent 可以同时启动多个子 agent
[
  {"name": "SubAgent", "input": {"prompt": "Task 1"}},
  {"name": "SubAgent", "input": {"prompt": "Task 2"}},
  {"name": "SubAgent", "input": {"prompt": "Task 3"}}
]
```

### 2. 减少轮数

对于简单任务，减少 `max_turns` 可以提高响应速度：

```yaml
default_max_turns: 3  # 简单任务
```

### 3. 限制工具范围

减少可用工具可以降低模型决策复杂度：

```yaml
default_allowed_tools: ["Read", "Grep"]  # 只提供必要的工具
```

## 更新日志

- **2026-04-07**: 初始版本，支持配置化的 SubAgent 工具
