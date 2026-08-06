# 百炼 Coding Plan Provider 切换设计

## 目标

将 `14.103.193.229` 上 Ripple 的有效模型 Provider 从火山 Coding Plan 切换为百炼 Model Studio Token Plan，并将主模型和 fallback 模型链与 `81.70.18.173` 对齐。

本次不调整 Ripple 的进程管理方式、构建类型、NAS 目录、数据库、Sandbox、Finance Skills 或对外 API。

## 当前状态

- 目标主机：`14.103.193.229`，代码为 `release-cn@56b9baf2243fcc37ff43f4183718a0cbb7066b8b`。
- Ripple 由 tmux 会话 `ripple-server-root` 启动，执行 `cargo run -p ripple-server`，监听 `0.0.0.0:8810`。
- 有效 Codex Home 为 `/nas/ripple/runtime/codex-service-home`。
- 当前 Provider 为 `volcengine-coding-plan`，默认模型为 `glm-latest`。
- 当前 fallback 为 `deepseek-v4-flash-260425`、`doubao-seed-2-0-code-preview-260215`。
- 百炼源主机 `81.70.18.173` 使用 Responses API，主模型为 `qwen3.7-plus`，fallback 为 `qwen3.6-flash`、`qwen3.7-max`。

## 变更范围

### Provider 配置

在目标主机有效 Codex 配置中：

- 将 `model_provider` 设置为 `Model_Studio_Token_Plan`；
- 将默认 `model` 设置为 `qwen3.7-plus`；
- 保持 `model_reasoning_effort = "medium"`；
- 配置 Provider：
  - `base_url = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"`
  - `env_key = "ARK_API_KEY"`
  - `wire_api = "responses"`
- 保留目标主机已有项目 trust 配置和其他非 Provider 配置，不整文件覆盖。

### Ripple 模型配置

在目标主机 `config/settings.yaml` 中：

- 四个 `codex-*` preset 均映射到 `qwen3.7-plus`；
- fallback 顺序改为：
  1. `qwen3.6-flash`，`reasoning_effort: low`
  2. `qwen3.7-max`，`reasoning_effort: low`
- 保留现有 NAS 路径、权限、连接器、Skill 和服务参数。

### 凭证与启动环境

- 从 `81.70.18.173` 安全传递百炼 Token Plan 凭证，不在终端输出，也不写入本地工作区。
- 在目标主机保存为新的 root-only 环境文件，权限为 `0600`。
- 新 tmux 启动命令只加载百炼环境文件，不再加载火山环境文件。
- 火山配置与凭证移出活动路径，仅保留带时间戳、权限为 `0600` 的回滚备份。

## 切换流程

1. 校验两台主机身份、代码 SHA、Codex 版本和目标文件哈希。
2. 备份目标主机的 `settings.yaml`、Codex `config.toml`、火山环境文件和 tmux 启动信息。
3. 在目标主机使用百炼凭证直接调用三个模型，确认网络、授权和配额可用，但不改变线上进程。
4. 对目标配置副本进行修改并做 YAML/TOML 解析校验。
5. 调用 `/v1/internal/drain`，等待 `active_jobs = 0`。
6. 原子替换配置和环境文件，停止旧 tmux 会话，再使用原有 tmux/debug 方式启动 Ripple。
7. 验证监听、进程路径、健康检查、模型目录和真实 Responses 请求。

## 验证标准

- Ripple 仍监听 `0.0.0.0:8810`，进程工作目录仍为 `/root/ripple`。
- 有效 Provider 是百炼 Token Plan，运行进程环境不再加载火山凭证。
- `qwen3.7-plus`、`qwen3.6-flash`、`qwen3.7-max` 均可直接完成真实请求。
- Ripple SSE 在合理时间内发出 `response.output_text.delta` 并以 `response.completed` 结束。
- 百炼 `response.output_item.added` 的 reasoning 项包含 `summary`，message 项包含 `content`。
- Codex 日志中没有新增：
  - `OutputTextDelta without active item`
  - `ReasoningSummaryDelta without active item`
  - `failed to parse ResponseItem from output_item.added`
- 使用不存在的模型触发可回滚错误后，日志确认 fallback 到 `qwen3.6-flash` 并完成。
- Finance Skills、NAS 路径和现有未跟踪文件保持不变。

## 失败处理与回滚

- 如果切换前百炼任一模型无法直接调用，不进入线上切换。
- 如果配置解析失败，不替换活动文件。
- 如果重启后健康检查或真实请求失败，停止新进程，恢复全部备份文件，并用原 tmux 命令恢复火山配置。
- 如果请求已经产生工具副作用，则不在同一任务中继续 fallback；遵循现有 runner 的回滚与副作用边界。

## 不在本次范围

- 不把 tmux/debug 改为 systemd/release。
- 不升级 Codex 或 Ripple 代码。
- 不修改 Finance Skills 或一次性上下文读取逻辑。
- 不调整 NextGen、外部路由、数据库或 NAS 数据。
