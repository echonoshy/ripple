# 代码体检记录 2026-04-30

本文档记录 2026-04-30 对 ripple 仓库的一次只读体检结果。此次检查没有修改业务代码，结论用于后续统一整改。

## 检查基线

- `uv run ruff check .`：通过
- `uv run ruff format --check .`：通过，100 files already formatted
- `uv run pytest`：通过，17 passed in 59.63s
- `bun run lint`：通过
- `bun run format:check`：通过
- `timeout 180s bun run build`：通过
- Git 工作区无 tracked 改动
- `.ripple/`、`.next/`、`node_modules/`、`config/settings.yaml`、`__pycache__` 均为 ignored 文件

## 问题清单

### P0：`/v1/tools/invoke` 绕过权限系统

位置：`src/interfaces/server/routes.py:1080`

`/v1/tools/invoke` 直接调用 `tool_instance.call(...)`，没有走 `execute_tool()` 或 `PermissionManager.check_permission()`。这意味着只要有 API key，就可以直接 invoke `Bash`、`Write` 等危险工具，绕过前端确认链路。

建议：

- 如果接口需要保留，统一走工具编排层。
- 或者限制该接口只允许 safe tools。
- 补充针对 `Bash` / `Write` 的权限绕过回归测试。

### P1：沙箱内 `Write` 覆盖确认判断失效

位置：`src/ripple/tools/builtin/write.py:152`

`WriteTool.requires_confirmation()` 直接用 `Path(file_path).exists()` 判断文件是否存在。Server 模式里模型通常传 `/workspace/foo`，该路径在宿主机上未必存在，因此覆盖 sandbox 里已有文件时可能不触发确认。

实际写入时又会通过 `validate_path()` 映射到真实 workspace，导致“确认判断”和“实际写入路径”不一致。

建议：

- 权限判断阶段也使用 sandbox path resolution。
- 或将 `requires_confirmation()` 的签名/调用方式调整为可访问 `ToolUseContext`。
- 增加 sandbox 模式下覆盖 `/workspace/existing.txt` 必须触发确认的测试。

### P1：Skill 缓存只看目录 mtime，编辑已有文件可能不生效

位置：

- `src/ripple/skills/loader.py:146`
- `src/ripple/skills/loader.py:201`

shared skills 和 workspace skills 的缓存只比较 skill 目录自身 mtime。修改已有 `SKILL.md` 的内容通常只更新文件 mtime，不一定更新父目录 mtime，因此可能继续使用旧缓存。

建议：

- 聚合递归文件 mtime 或维护更明确的 cache key。
- 在写入/安装 skill 后显式 invalidate 对应缓存。
- 增加“修改已有 SKILL.md 后重新加载”的测试。

### P1：Scheduler 更新运行中任务缺少并发保护

位置：

- `src/interfaces/server/routes.py:915`
- `src/ripple/scheduler/manager.py:154`

`PATCH /v1/sandbox/schedules/{job_id}` 允许更新任意 job。`SchedulerManager.update_job()` 没有持有 `_state_lock`，也不像 delete 一样拒绝 running job。运行中修改 command、prompt、enabled、next_run_at 等字段，可能和 `run_job()` 的状态写回互相覆盖。

建议：

- `update_job()` 加 `_state_lock`。
- 对 running job 定义明确策略：拒绝更新、仅允许部分字段更新，或延迟到下一次运行生效。
- 增加 running job update 的并发测试。

### P2：Bash 危险命令识别偏字符串匹配

位置：`src/ripple/tools/builtin/bash.py:249`

`BashTool.requires_confirmation()` 使用 substring 判断危险命令，容易误判和漏判，例如命令重定向、组合命令、shell quoting、`git -C repo push` 等变体。

建议：

- 基于 `shlex` 后的命令段解析。
- 或将 destructive 判断下沉到更结构化的 command policy。
- 对 `rm`、`git push`、`git reset --hard`、`git -C repo push`、重定向等场景补测试。

### P2：测试覆盖偏窄

当前只有 2 个测试文件，主要覆盖 scheduler store 和 bilibili pipeline。

缺少测试的高风险路径：

- Server routes
- 权限恢复
- sandbox path validation
- skill cache
- SSE streaming
- session persist / resume
- tools invoke 权限边界

建议优先围绕 P0/P1 问题补回归测试。

### P2：前端包管理存在混用迹象

位置：

- `src/interfaces/web/bun.lock`
- `src/interfaces/web/package-lock.json`
- `src/interfaces/web/package.json`

仓库同时跟踪了 `bun.lock` 和 `package-lock.json`，但项目说明和脚本使用 bun。需要确认是否真的需要 npm lock，否则会制造依赖解析歧义。

建议：

- 明确前端唯一包管理器。
- 如果统一使用 bun，移除或停止维护 npm lock。
- 如果兼容 npm，需要在文档里说明双 lockfile 的维护规则。

## 模块结论

### Server / API

整体结构清晰，`user_id` 依赖校验方向正确。最大风险是 `/v1/tools/invoke` 权限绕过。

### Core / Streaming

主循环、SSE、usage 汇总跑通，未发现明显阻断级问题。

### Sandbox / Permissions

user 级 lock 和路径校验方向正确。当前最实际的安全缺口是 `Write.requires_confirmation()` 与 sandbox 路径解析不一致。

### Skills

功能完整，但缓存失效策略不可靠。修改已有 skill 文件后可能继续使用旧内容。

### Scheduler

已有持久化和恢复逻辑，但 update/run 并发边界需要收紧。

### Web

lint、format、build 均通过，API 对接基本一致。主要工程问题是 lockfile 混用。

### Security / Repo Hygiene

未看到真实密钥被 tracked。`config/settings.yaml` 和前端 `.env.local` 均为 ignored 文件。

## 建议处理顺序

1. 修复 `/v1/tools/invoke` 权限绕过。
2. 修复 `Write` 覆盖确认在 sandbox 模式下的路径判断。
3. 修复 skill cache 失效策略。
4. 收紧 scheduler update/run 并发边界。
5. 为上述问题补回归测试。
6. 统一前端 lockfile 策略。
