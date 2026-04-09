# Hooks 系统设计分析

> 基于 claude-code 源码分析 + ripple 现状评估，作为后续实现的参考文档。

## 1. Hooks 是什么

Hooks 是插在 Agent 生命周期关键节点上的**拦截器/扩展点**，让用户或系统可以在 Agent 执行过程的特定时刻运行自定义逻辑（shell 命令、LLM prompt、HTTP 请求、子 Agent 等），实现审计、校验、拦截、改参、注入上下文等功能。

类比：类似 Git Hooks（pre-commit / post-commit），但作用在 Agent 的工具调用和对话循环上。

---

## 2. Claude-Code 的 Hooks 架构

### 2.1 事件类型（27 种）

| 分类 | 事件 | 用途 |
|------|------|------|
| 工具调用 | `PreToolUse` | 工具执行前 — 审计/改参数/预授权/拦截 |
| | `PostToolUse` | 工具成功后 — 注入反馈、改 MCP 输出 |
| | `PostToolUseFailure` | 工具失败后 |
| 权限 | `PermissionRequest` | 请求权限时 |
| | `PermissionDenied` | 权限被拒后 |
| 用户输入 | `UserPromptSubmit` | 用户提交 prompt 时（可拦截/修改） |
| 会话生命周期 | `SessionStart` / `SessionEnd` / `Setup` | 会话开始/结束/仓库初始化 |
| Turn 结束 | `Stop` / `SubagentStop` / `StopFailure` | 主 Agent / 子 Agent 回合结束时校验 |
| 压缩 | `PreCompact` / `PostCompact` | 对话压缩前后 |
| 通知 | `Notification` | 系统通知 |
| 环境 | `CwdChanged` / `FileChanged` / `ConfigChange` | 工作目录/文件/配置变化 |
| 协作 | `SubagentStart` / `TeammateIdle` / `TaskCreated` / `TaskCompleted` | 子 Agent 和任务管理 |
| 其他 | `Elicitation` / `ElicitationResult` / `WorktreeCreate` / `WorktreeRemove` / `InstructionsLoaded` | MCP 交互、worktree、指令加载 |

### 2.2 Hook 实现方式（4 种持久化 + 2 种运行时）

| 类型 | 说明 |
|------|------|
| `command` | 执行 shell 命令，通过 exit code 和 stdout JSON 返回结果 |
| `prompt` | 调用 LLM 评估，`$ARGUMENTS` 占位符注入上下文 |
| `agent` | 运行子 Agent 做验证 |
| `http` | 向 URL 发 POST，响应体为 JSON |
| `callback` | SDK/内部注册的回调（不可序列化） |
| `function` | 会话内存中的函数 hook |

### 2.3 配置格式

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .claude/hooks/precheck.py",
            "if": "Bash(git *)",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "prompt", "prompt": "检查 $ARGUMENTS 是否符合规范" }
        ]
      }
    ]
  }
}
```

- 按事件名分组 → 每组是 matcher 数组
- 每个 matcher 有可选的 `matcher`（匹配工具名/通知类型等）和 `hooks` 数组

### 2.4 Hook 结果的 JSON 语义

Hook 通过 stdout 输出 JSON，支持以下字段：

- `decision: "approve" | "block"` — 粗粒度允许/拒绝
- `continue: false` — 阻止对话继续，可附带 `stopReason`
- `reason` — 阻塞原因文本
- 按事件类型有扩展字段：
  - PreToolUse: `permissionDecision`, `updatedInput`, `additionalContext`
  - PostToolUse: `updatedMCPToolOutput`

### 2.5 执行流程

```
用户配置 hooks (settings.json)
      ↓
插件/Skill frontmatter 注册 hooks
      ↓
合并配置 → getHooksConfig()
      ↓
事件触发 → getMatchingHooks() 按 matcher 过滤
      ↓
executeHooks() 并行执行所有匹配的 hook
      ↓
processHookJSONOutput() 解析结果
      ↓
返回：allow/deny/block/改参数/注入上下文/阻止继续
```

### 2.6 关键源码文件（claude-code）

| 文件 | 作用 |
|------|------|
| `src/utils/hooks.ts` | 主入口：匹配、执行、结果解析 |
| `src/schemas/hooks.ts` | 配置的 Zod schema 定义 |
| `src/services/tools/toolHooks.ts` | PreToolUse / PostToolUse 的包装 |
| `src/services/tools/toolExecution.ts` | Agent 工具循环中的调用点 |
| `src/query/stopHooks.ts` | Stop Hook 执行 |
| `src/utils/hooks/sessionHooks.ts` | 会话内动态注册 |
| `src/utils/hooks/execPromptHook.ts` | prompt 类型执行器 |
| `src/utils/hooks/execAgentHook.ts` | agent 类型执行器 |
| `src/utils/hooks/execHttpHook.ts` | http 类型执行器 |
| `src/entrypoints/sdk/coreTypes.ts` | HOOK_EVENTS 枚举定义 |

---

## 3. Ripple 现状

### 3.1 已有的代码

- `src/ripple/hooks/executor.py`：仅一个文件，包含 `StopHookResult` 数据类和两个空壳函数
- `execute_stop_hooks` → 直接返回空结果（TODO）
- `execute_single_hook` → 直接返回 success（TODO）

### 3.2 Agent Loop 中的接入点

`agent_loop.py` 已在"无工具调用时的收尾"阶段预埋了 Stop Hook 调用：

- 调用 `_handle_stop_hooks()` 获取结果
- `prevent_continuation=True` → `TerminalStopHookPrevented`（终止）
- `blocking_errors` 不为空 → `ContinueStopHookBlocking`（多跑一轮让模型处理）

### 3.3 已定义但未使用的 Transitions

`transitions.py` 中已定义了多种与 hooks 相关的状态转换：

- `TerminalStopHookPrevented` — Stop Hook 阻止继续（已接入但 hook 始终返回空）
- `TerminalHookStopped` — Hook 停止（未使用）
- `ContinueStopHookBlocking` — Stop Hook 阻塞后重试（已接入但 hook 始终返回空）

### 3.4 缺失项

| 缺失 | 说明 |
|------|------|
| hooks 配置段 | `settings.yaml` 中无 hooks 配置 |
| Hook 数据模型 | 无 HookEvent / HookMatcher / HookCommand 等类型定义 |
| 匹配机制 | 无按事件名 + matcher 过滤的逻辑 |
| 执行引擎 | `execute_single_hook` 未实现任何类型 |
| 结果解析 | 无 JSON stdout 解析逻辑 |
| PreToolUse | `orchestration.py` 中无调用点 |
| PostToolUse | `orchestration.py` 中无调用点 |
| Skill hooks | Skill frontmatter 的 `hooks` 字段已加载但未生效 |

---

## 4. 建议实现路径

### Phase 1: 基础设施

> 目标：让 hooks 系统有数据模型和配置来源

1. 定义 Hook 数据模型（`src/ripple/hooks/types.py`）

```python
@dataclass
class HookEvent:
    """支持的事件类型枚举"""
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    STOP = "Stop"

@dataclass
class HookCommand:
    """单个 hook 的定义"""
    type: str              # "command" | "prompt" | "agent"
    command: str | None     # type=command 时的 shell 命令
    prompt: str | None      # type=prompt 时的 LLM prompt
    timeout: int = 30       # 超时秒数
    if_condition: str | None = None  # 可选条件表达式

@dataclass
class HookMatcher:
    """matcher + hooks 列表"""
    matcher: str | None     # 匹配模式（工具名等），None 表示匹配所有
    hooks: list[HookCommand]

@dataclass
class HookResult:
    """hook 执行结果"""
    decision: str | None = None      # "approve" | "block"
    reason: str | None = None
    continue_: bool = True
    updated_input: dict | None = None
    prevent_continuation: bool = False
```

2. `settings.yaml` 增加 hooks 配置段

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "python3 scripts/check_bash.py"
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: "python3 scripts/check_output.py"
```

3. `config.py` 中增加 hooks 配置加载

### Phase 2: 执行引擎

> 目标：能真正执行 hook 并解析结果

1. Hook 匹配器（`src/ripple/hooks/matcher.py`）
   - `get_matching_hooks(event, match_query, config)` → 过滤出匹配的 hooks
   - 支持精确匹配、`|` 分隔的多选、`*` 通配

2. Hook 执行器完善（`src/ripple/hooks/executor.py`）
   - `execute_command_hook`：subprocess 执行 shell 命令，捕获 stdout/stderr
   - `execute_hooks`：并行执行匹配的 hooks，汇总结果
   - 结果解析：解析 stdout 中的 JSON，映射到 `HookResult`
   - exit code 语义：0=通过，2=阻塞，其他=错误

3. prompt 类型执行器（后续）
   - 用现有的 API client 调用 LLM 评估

### Phase 3: 接入 Agent Loop

> 目标：hooks 真正在关键节点生效

1. **Stop Hook 实装**
   - 已有调用骨架，补充从配置加载 + 匹配 + 执行的完整逻辑

2. **PreToolUse**
   - 在 `orchestration.py` 的 `_execute_tool` 中，权限检查之前/之后加入调用点
   - hook 可返回 `decision: "block"` 拦截，或 `updated_input` 改写参数

3. **PostToolUse**
   - 在 `_execute_tool` 中，工具返回结果之后加入调用点
   - hook 可做审计日志、结果过滤

### Phase 4: 增强（按需）

- prompt 类型 hook 实现
- Skill frontmatter 中 `hooks` 字段生效
- `SessionStart` / `SessionEnd` 事件
- `UserPromptSubmit` 事件
- Hook 的 `if` 条件表达式求值
- 异步 hook 支持

---

## 5. 优先级建议

**先聚焦三个核心事件 + command 类型执行器：**

| 优先级 | 事件 | 覆盖场景 |
|--------|------|----------|
| P0 | `PreToolUse` | 工具调用安全（拦截危险 bash 命令等） |
| P0 | `Stop` | 输出质量校验 |
| P1 | `PostToolUse` | 结果审计、敏感信息脱敏 |
| P2 | `SessionStart/End` | 会话初始化/清理 |
| P3 | 其他事件 | 按需添加 |

不要照搬 claude-code 的 27 种事件。ripple 的定位和复杂度不同，先把核心跑通，再按需扩展。

---

## 6. 前置依赖提醒

实现 hooks 之前，以下问题值得同步关注：

1. **`allowed_tools` 与 API 工具列表打通**：目前 `_prepare_tool_definitions` 未根据 `context.allowed_tools` 过滤工具，导致模型能看到被限制的工具。这影响 PreToolUse hook 的"拦截"效果——不如从源头就不暴露。

2. **权限系统与 hooks 的关系**：`PermissionManager` 是"按风险等级交互式问用户"，PreToolUse hook 是"按自定义规则自动决策"。两者应互补而非冲突，需设计好优先级（建议：hook 优先 → 权限其次）。

3. **单次 CLI（`run` 命令）无 PermissionManager**：如果 hooks 要在非交互模式下也生效，执行引擎不能依赖交互式输入。
