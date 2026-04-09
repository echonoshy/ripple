---
name: ripple-agent
description: "使用 Ripple Agent 自主执行复杂编码任务 — 支持文件读写、命令执行、代码搜索、多轮交互"
allowed-tools:
  - Bash
when-to-use: "当需要自主完成复杂的编码任务时使用，如代码重构、文件批量处理、项目分析、自动化脚本执行等。Ripple 拥有完整的工具链（Bash/Read/Write/Search），可以自主规划和执行多步骤任务。"
---

# Ripple Agent — 自主编码执行器

你需要通过 Ripple Agent CLI 来执行一个编码任务。Ripple 是一个具备完整工具链的 Agent，可以自主调用 Bash、文件读写、代码搜索等工具来完成复杂任务。

用户请求: $ARGUMENTS

## 使用方法

### 1. 执行任务

```bash
cd /home/lake/workspace/ripple && uv run ripple execute "<任务描述>" --cwd <工作目录>
```

参数说明:
- `<任务描述>`: 清晰、具体的任务描述（必须用引号包裹）
- `--cwd <路径>`: 指定 Ripple 的工作目录（默认为当前目录）
- `--max-turns <N>`: 最大执行轮数（默认 10）
- `--stream`: 启用实时 JSONL 流式输出

### 2. 解析输出

Ripple 输出 JSON 到 stdout。根据 `status` 字段判断结果:

**任务完成 (`status: "completed"`)**:
```json
{
  "status": "completed",
  "session_id": "rpl-20260409-143052-a3f2c1",
  "result": "任务执行结果描述...",
  "turns_used": 5,
  "tool_calls": [
    {"tool": "Read", "success": true, "output_preview": "..."},
    {"tool": "Write", "success": true, "output_preview": "..."}
  ]
}
```

**需要输入 (`status: "needs_input"`)**:
```json
{
  "status": "needs_input",
  "session_id": "rpl-20260409-143052-a3f2c1",
  "question": "你希望使用哪个框架？",
  "options": ["FastAPI", "Flask", "Starlette"],
  "progress": "已创建项目结构...",
  "turns_used": 3
}
```

**执行出错 (`status: "error"`)**:
```json
{
  "status": "error",
  "session_id": "rpl-20260409-143052-a3f2c1",
  "error": "错误描述...",
  "turns_used": 2
}
```

### 3. 继续被挂起的 session

当 Ripple 返回 `needs_input` 时，使用 `continue` 命令提供回答:

```bash
cd /home/lake/workspace/ripple && uv run ripple continue <session_id> "<你的回答>"
```

### 4. 流式输出（可选）

使用 `--stream` 获取实时执行进度，每行一个 JSON 事件:

```bash
cd /home/lake/workspace/ripple && uv run ripple execute "任务描述" --stream
```

事件类型:
- `{"type": "tool_call", "tool": "Read", "input": {...}}` — 工具调用
- `{"type": "tool_result", "tool": "Read", "success": true, ...}` — 工具结果
- `{"type": "text", "content": "..."}` — Agent 思考/回复文本
- `{"type": "needs_input", "question": "...", ...}` — 需要输入
- `{"type": "complete", "status": "completed", ...}` — 执行完毕

## 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 任务完成 |
| 10 | 需要用户输入（需要 continue） |
| 1 | 执行出错 |

## 最佳实践

1. **任务描述要具体**: 包含明确的目标、约束条件和偏好，减少 Ripple 需要询问的次数
2. **指定工作目录**: 总是通过 `--cwd` 指定目标项目路径
3. **检查 tool_calls**: 通过 `tool_calls` 数组验证 Ripple 执行了预期的操作
4. **处理 needs_input**: 收到此状态时，根据 `question` 和 `options` 自行决策或向用户转发
5. **不要使用 `2>&1`**: Bash 工具会自动流式读取 stderr 进度信息并实时展示，不要将 stderr 重定向到 stdout
6. **设置足够的 timeout**: 对于复杂任务建议设置 `"timeout": 600`，避免因超时中断

## Session 管理

```bash
# 列出所有 sessions
cd /home/lake/workspace/ripple && uv run ripple session list

# 查看 session 详情
cd /home/lake/workspace/ripple && uv run ripple session show <session_id>

# 删除 session
cd /home/lake/workspace/ripple && uv run ripple session delete <session_id>
```

## Ripple 内置工具

Ripple Agent 在执行任务时可使用以下工具:

| 工具 | 能力 |
|------|------|
| Bash | 执行 shell 命令 |
| Read | 读取文件内容 |
| Write | 写入/创建文件 |
| Search | 搜索代码（grep/glob） |
| Agent | 派生子 Agent 处理子任务 |
| Skill | 调用已注册的技能 |
| AskUser | 向调用方请求更多信息 |
