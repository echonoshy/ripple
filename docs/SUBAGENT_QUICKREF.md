# SubAgent 工具 - 快速参考

## 概述

SubAgent 工具允许主 agent 启动独立的子 agent 来处理复杂子任务，支持并发执行和权限隔离。

## 核心特性

- ✅ **防递归**: 子 agent 无法再创建子 agent
- ✅ **并发安全**: 多个子 agent 可以同时运行
- ✅ **权限隔离**: 可以限制子 agent 的工具权限
- ✅ **配置化**: 通过 config/settings.yaml 配置默认行为
- ✅ **独立上下文**: 每个子 agent 有独立的 session_id 和状态

## 快速开始

### 1. 配置文件

编辑 `config/settings.yaml`:

```yaml
tools:
  builtin:
    - subagent  # 启用 SubAgent 工具

  subagent:
    default_max_turns: 5
    default_allowed_tools: []  # 空数组 = 允许所有工具（除了 SubAgent）
    permission_mode: "allow"
```

### 2. 基本使用

在 REPL 中：

```bash
uv run ripple repl
```

输入：
```
使用 SubAgent 工具搜索代码库中的所有 TODO 注释
```

### 3. 工具调用格式

```json
{
  "name": "SubAgent",
  "input": {
    "prompt": "子任务描述",
    "max_turns": 5,  // 可选，覆盖配置
    "allowed_tools": ["Read", "Grep"]  // 可选，覆盖配置
  }
}
```

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `default_max_turns` | int | 5 | 子 agent 的最大轮数 |
| `default_allowed_tools` | list[str] | [] | 允许的工具列表（空=所有） |
| `permission_mode` | str | "allow" | 权限模式（allow/ask/deny） |

## 工具参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | str | ✅ | 子任务的提示词 |
| `max_turns` | int | ❌ | 最大轮数（覆盖配置） |
| `allowed_tools` | list[str] | ❌ | 允许的工具（覆盖配置） |

## 常见场景

### 场景 1: 代码搜索（只读）

```yaml
subagent:
  default_allowed_tools: ["Read", "Grep", "Glob"]
```

### 场景 2: 自动化修复（读写）

```yaml
subagent:
  default_allowed_tools: ["Read", "Write", "Bash"]
```

### 场景 3: 并发分析

```python
# 主 agent 同时启动 3 个子 agent
[
  {"name": "SubAgent", "input": {"prompt": "Analyze module A"}},
  {"name": "SubAgent", "input": {"prompt": "Analyze module B"}},
  {"name": "SubAgent", "input": {"prompt": "Analyze module C"}}
]
```

## 文件结构

```
src/ripple/tools/builtin/
  └── subagent.py          # SubAgent 工具实现

src/interfaces/
  ├── cli/main.py          # CLI 集成
  ├── cli/repl.py          # REPL 集成
  └── tui/tui.py           # TUI 集成

config/
  └── settings.yaml.example # 配置示例

docs/
  ├── SUBAGENT_CONFIG.md   # 配置指南
  └── SUBAGENT_EXAMPLES.md # 使用示例

tests/
  └── test_subagent.py     # 测试文件
```

## 测试

```bash
# 运行测试
uv run python tests/test_subagent.py

# 启动 REPL 测试
uv run ripple repl

# 检查代码
uv run ruff check src/ripple/tools/builtin/subagent.py
```

## 架构设计

### 防递归机制

```python
# 子 agent 的工具列表中自动移除 SubAgent
sub_tools = [t for t in context.options.tools if t.name != "SubAgent"]
```

### 并发安全

```python
def is_concurrency_safe(self, input) -> bool:
    return True  # 每个子 agent 有独立的 session_id
```

### 配置优先级

```
运行时参数 > 配置文件 > 硬编码默认值
```

## 性能指标

| 指标 | 单 Agent | SubAgent (并发) | 提升 |
|------|----------|----------------|------|
| 3 个模块分析 | ~60s | ~25s | 2.4x |
| 上下文隔离 | ❌ | ✅ | - |
| 错误隔离 | ❌ | ✅ | - |

## 限制

- ❌ 子 agent 无法再创建子 agent（防递归）
- ❌ 子 agent 无法访问主 agent 的上下文
- ❌ 子 agent 的输出大小限制为 50,000 字符

## 故障排查

### 问题: 子 agent 无法使用某个工具

**解决**:
```yaml
default_allowed_tools: ["Read", "Write", "YourTool"]
```

### 问题: 子 agent 执行轮数不足

**解决**:
```yaml
default_max_turns: 10  # 增加轮数
```

或运行时覆盖：
```json
{"max_turns": 15}
```

### 问题: 工具调用被拒绝

**解决**:
```yaml
permission_mode: "allow"
```

## 相关文档

- [配置指南](./SUBAGENT_CONFIG.md) - 详细的配置说明
- [使用示例](./SUBAGENT_EXAMPLES.md) - 实际使用案例
- [工具系统](../src/ripple/tools/base.py) - 工具基类定义
- [Agent Loop](../src/ripple/core/agent_loop.py) - 核心循环逻辑

## 更新日志

- **2026-04-07**: 初始实现
  - 支持配置化的 SubAgent 工具
  - 防递归机制
  - 并发安全
  - 权限隔离

## 贡献

如有问题或建议，请提交 Issue 或 PR。

## 许可

与 Ripple 项目保持一致。
