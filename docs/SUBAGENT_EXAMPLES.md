# SubAgent 工具使用示例

本文档提供 SubAgent 工具的实际使用示例。

## 基本使用

### 示例 1: 代码搜索任务

**场景**: 让子 agent 搜索代码库中的所有 TODO 注释

**配置** (`config/settings.yaml`):
```yaml
tools:
  subagent:
    default_max_turns: 5
    default_allowed_tools: ["Read", "Grep", "Glob"]
    permission_mode: "allow"
```

**用户输入**:
```
请使用 SubAgent 工具搜索代码库中的所有 TODO 注释，并总结它们的内容。
```

**模型调用**:
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Search the codebase for all TODO comments and summarize them"
  }
}
```

**预期结果**:
- 子 agent 使用 Grep 搜索 TODO 注释
- 使用 Read 读取相关文件
- 返回 TODO 列表和摘要

---

### 示例 2: 自动化 Bug 修复

**场景**: 让子 agent 分析并修复一个 bug

**配置**:
```yaml
tools:
  subagent:
    default_max_turns: 10
    default_allowed_tools: ["Read", "Write", "Bash", "Grep"]
    permission_mode: "allow"
```

**用户输入**:
```
使用 SubAgent 工具修复 src/auth.py 中的登录验证 bug
```

**模型调用**:
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Fix the login validation bug in src/auth.py. Read the file, identify the issue, fix it, and run tests.",
    "max_turns": 10,
    "allowed_tools": ["Read", "Write", "Bash", "Grep"]
  }
}
```

**预期结果**:
- 子 agent 读取 auth.py
- 分析代码找到 bug
- 修复代码
- 运行测试验证

---

### 示例 3: 并发任务处理

**场景**: 同时分析多个模块

**配置**:
```yaml
tools:
  subagent:
    default_max_turns: 5
    default_allowed_tools: ["Read", "Grep", "Glob"]
    permission_mode: "allow"
```

**用户输入**:
```
分析 core、api、tools 三个模块的代码结构
```

**模型调用** (并发):
```json
[
  {
    "name": "SubAgent",
    "input": {
      "prompt": "Analyze the code structure of the core module"
    }
  },
  {
    "name": "SubAgent",
    "input": {
      "prompt": "Analyze the code structure of the api module"
    }
  },
  {
    "name": "SubAgent",
    "input": {
      "prompt": "Analyze the code structure of the tools module"
    }
  }
]
```

**预期结果**:
- 三个子 agent 并发执行
- 每个子 agent 分析一个模块
- 主 agent 汇总结果

---

## 高级用法

### 示例 4: 动态工具权限

**场景**: 根据任务类型动态调整工具权限

**配置**:
```yaml
tools:
  subagent:
    default_max_turns: 5
    default_allowed_tools: []  # 默认允许所有工具
    permission_mode: "allow"
```

**只读任务**:
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Analyze the codebase structure",
    "allowed_tools": ["Read", "Grep", "Glob"]
  }
}
```

**读写任务**:
```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "Refactor the authentication module",
    "allowed_tools": ["Read", "Write", "Bash"]
  }
}
```

---

### 示例 5: 多层任务分解

**场景**: 主 agent 将复杂任务分解为多个子任务

**用户输入**:
```
实现一个新的用户注册功能，包括前端表单、后端 API、数据库迁移和测试
```

**主 agent 策略**:
1. 使用 SubAgent 1: 创建数据库迁移
2. 使用 SubAgent 2: 实现后端 API
3. 使用 SubAgent 3: 创建前端表单
4. 使用 SubAgent 4: 编写测试

**模型调用序列**:
```json
// 步骤 1
{
  "name": "SubAgent",
  "input": {
    "prompt": "Create database migration for user registration table",
    "allowed_tools": ["Read", "Write", "Bash"],
    "max_turns": 5
  }
}

// 步骤 2
{
  "name": "SubAgent",
  "input": {
    "prompt": "Implement backend API endpoint for user registration",
    "allowed_tools": ["Read", "Write", "Bash"],
    "max_turns": 8
  }
}

// 步骤 3
{
  "name": "SubAgent",
  "input": {
    "prompt": "Create frontend registration form component",
    "allowed_tools": ["Read", "Write"],
    "max_turns": 6
  }
}

// 步骤 4
{
  "name": "SubAgent",
  "input": {
    "prompt": "Write integration tests for registration flow",
    "allowed_tools": ["Read", "Write", "Bash"],
    "max_turns": 5
  }
}
```

---

## 实际测试

### 测试 1: 基本功能测试

运行测试脚本：
```bash
uv run python tests/test_subagent.py
```

### 测试 2: REPL 交互测试

启动 REPL：
```bash
uv run ripple repl
```

输入测试提示：
```
使用 SubAgent 工具列出当前目录下的所有 Python 文件
```

预期输出：
```
[Tool Call] SubAgent
  Input: {"prompt": "List all Python files in the current directory", ...}

[Tool Result] SubAgentOutput(result='...', turns_used=2)

[Assistant] 子 agent 找到了以下 Python 文件：
- src/ripple/core/agent_loop.py
- src/ripple/tools/base.py
- ...
```

---

## 调试技巧

### 1. 查看子 agent 的执行过程

在 SubAgentTool 中添加日志：
```python
# 在 subagent.py 中
print(f"[SubAgent] Starting with tools: {[t.name for t in sub_tools]}")
print(f"[SubAgent] Max turns: {max_turns}")
```

### 2. 测试工具权限

```python
# 测试只读权限
{
  "name": "SubAgent",
  "input": {
    "prompt": "Try to write a file",
    "allowed_tools": ["Read"]  # 不包含 Write
  }
}
# 预期：子 agent 无法写入文件
```

### 3. 测试防递归

```python
# 测试子 agent 无法创建子 agent
{
  "name": "SubAgent",
  "input": {
    "prompt": "Use SubAgent tool to create another sub-agent",
    "allowed_tools": []  # 即使允许所有工具
  }
}
# 预期：子 agent 的工具列表中没有 SubAgent
```

---

## 性能对比

### 单 Agent vs SubAgent

**场景**: 分析 3 个模块的代码结构

**单 Agent 方式**:
- 顺序执行 3 个任务
- 总时间: ~60 秒
- 上下文混杂

**SubAgent 方式**:
- 并发执行 3 个子 agent
- 总时间: ~25 秒
- 上下文隔离

**优势**:
- ✅ 速度提升 2.4x
- ✅ 上下文清晰
- ✅ 错误隔离

---

## 常见问题

### Q1: 子 agent 可以访问主 agent 的上下文吗？

**A**: 不可以。子 agent 有独立的上下文和 session_id，无法访问主 agent 的状态。

### Q2: 子 agent 的输出会影响主 agent 吗？

**A**: 子 agent 的输出作为工具结果返回给主 agent，主 agent 可以基于这些结果继续工作。

### Q3: 可以嵌套多层子 agent 吗？

**A**: 不可以。子 agent 的工具列表中自动移除了 SubAgent 工具，防止递归。

### Q4: 子 agent 的最大轮数用完会怎样？

**A**: 子 agent 会停止执行，返回已完成的部分结果。

### Q5: 如何限制子 agent 的资源使用？

**A**: 通过配置 `max_turns` 和 `allowed_tools` 来限制：
```yaml
tools:
  subagent:
    default_max_turns: 3  # 限制轮数
    default_allowed_tools: ["Read"]  # 限制工具
```

---

## 最佳实践

### 1. 明确子任务边界

✅ 好的提示：
```
使用 SubAgent 搜索所有包含 "TODO" 的文件，并统计数量
```

❌ 不好的提示：
```
使用 SubAgent 做一些代码分析
```

### 2. 合理分配工具权限

✅ 只读任务：
```json
{"allowed_tools": ["Read", "Grep", "Glob"]}
```

✅ 修改任务：
```json
{"allowed_tools": ["Read", "Write", "Bash"]}
```

❌ 过度权限：
```json
{"allowed_tools": []}  // 对于简单任务给予所有工具
```

### 3. 设置合理的轮数限制

- 简单查询: 3-5 轮
- 代码分析: 5-8 轮
- 复杂修改: 10-15 轮

### 4. 利用并发能力

对于独立的子任务，让主 agent 并发调用多个 SubAgent：
```python
# 主 agent 可以同时启动多个子 agent
# 系统会自动并发执行
```

---

## 总结

SubAgent 工具适用于：
- ✅ 复杂任务分解
- ✅ 并发任务处理
- ✅ 上下文隔离
- ✅ 权限控制

不适用于：
- ❌ 简单的单步操作
- ❌ 需要共享状态的任务
- ❌ 需要多层嵌套的场景
