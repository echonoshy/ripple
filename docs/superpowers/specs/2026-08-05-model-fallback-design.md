# Ripple Server 模型降级设计

## 背景

Ripple 当前把调用方选择的模型直接交给 Codex app-server。模型容量不足、模型不存在、账号不支持模型或模型线路临时不可用时，Codex turn 以 `failed` 结束。`CodexAppServerProvider` 目前只保留固定错误 `codex turn failed`，既丢失 `turn.error` 的结构化原因，也没有模型降级能力。

本次变更只修改 Ripple Server。NextGen 的请求、SSE 消费方式和响应协议保持不变。

## 目标

- 调用方选择的模型因模型级错误不可用时，在同一个 Ripple job 内自动尝试后备模型。
- 默认降级顺序为：
  1. `gpt-5.6-luna`，`reasoning_effort: low`
  2. `gpt-5.6-terra`，`reasoning_effort: low`
  3. `gpt-5.5`，`reasoning_effort: low`
- 原始模型始终是第一次尝试；随后追加配置中的降级链并按模型名去重。
- 只有尚未产生外部可见输出或副作用的模型级失败可以降级。
- 模型切换对调用方完全透明，只进入 Ripple 内部日志。

## 非目标

- 不修改 NextGen 代码或调用协议。
- 不向 SSE 增加 fallback 事件或新字段。
- 不把鉴权、权限、沙箱、工具、超时或取消错误伪装成模型不可用。
- 不在 codex-multi-auth 代理中实现模型路由。
- 不对已产生输出或副作用的 turn 自动重放。

## 配置

在 `model` 下增加可选的 `fallback_chain`：

```yaml
model:
  fallback_chain:
    - model: "gpt-5.6-luna"
      reasoning_effort: "low"
    - model: "gpt-5.6-terra"
      reasoning_effort: "low"
    - model: "gpt-5.5"
      reasoning_effort: "low"
```

配置缺失或为空时不启用 fallback，保持现有行为。每项必须包含非空 `model`；`reasoning_effort` 沿用现有合法值校验。非法配置应在启动时明确失败，不能静默忽略。

当前部署的 `config/settings.yaml` 需要显式加入该链；示例配置同步更新，但正式配置不提交到 Git。

## 候选模型生成

Ripple 完成现有 preset 解析后，以实际模型名和 reasoning effort 构造第一次尝试，再依次追加 `fallback_chain`。

按实际模型名去重，而不是按 `(model, effort)` 去重。这样原始模型已是 Luna、Terra 或 5.5 时不会使用另一 reasoning effort 重复请求同一条不可用模型线路。

示例：

- 原始 `gpt-5.4`：`gpt-5.4 -> Luna low -> Terra low -> 5.5 low`
- 原始 `Luna low`：`Luna low -> Terra low -> 5.5 low`
- 原始 `Terra high`：`Terra high -> 5.5 low`
- 原始 `codex-low`：preset 解析为 `gpt-5.5 low`，没有后续候选模型。

## Runner 执行流程

降级逻辑放在 `CodexAppServerProvider::run`，复用同一个 job、事件文件、session 和对外响应生命周期。

每次尝试：

1. 使用候选模型和 effort 启动 Codex turn。
2. 收集通知、输出活动和结构化 `turn.error`。
3. 成功时结束候选循环，按现有流程完成 job。
4. 失败时判断错误类型与本轮活动状态。
5. 不满足降级条件时立即结束，保留真实错误。
6. 满足条件时清理 turn 注册、approval、user-input 等瞬态状态。
7. 回滚刚刚失败的一个 turn，避免后续模型看到重复用户输入。
8. 回滚成功后尝试下一候选模型。

Codex app-server 当前仍支持 `thread/rollback`，但已标记 deprecated。本次只用它回滚刚失败且无副作用的一个 turn。若回滚失败，停止降级并返回原始失败，不能带着不确定会话状态继续执行。未来 Codex 移除该方法时，应改为基于失败前 turn 边界的 `thread/fork`。

## 结构化错误与降级判定

`collect_turn` 不再把所有失败压缩成 `codex turn failed`。它需要保留：

- `turn.error.message`
- `turn.error.codexErrorInfo`
- `turn.error.additionalDetails`
- 可用时的 HTTP 状态码
- 当前尝试是否已产生输出或副作用

以下情况允许降级：

- capacity / overloaded
- model not found / unsupported
- entitlement / model access unavailable
- 模型请求返回 429、502、503、504

HTTP 状态码只能在错误来自模型采样阶段时用于判定，不能把工具或其他上游的同名状态码归类为模型不可用。

同时必须满足本轮没有：

- assistant 文本输出
- 工具调用开始或完成
- 文件修改
- approval 请求
- request-user-input 请求
- 其他已发送给调用方的控制面事件

以下错误不允许降级：

- 服务端 Codex 鉴权失败
- sandbox 或权限失败
- 工具执行失败
- 整体运行超时
- 用户取消或 interrupt
- 未识别的普通 server error
- 已产生输出或副作用后的任何失败

## 事件流与协议兼容

模型终止错误通常先以 `error` / `turn/error` 通知出现，随后才收到 `turn/completed(status=failed)`。为了静默降级，runner 需要暂存这组终止事件，等失败分类完成后再决定：

- 可以降级：不把原始失败事件暴露给现有 SSE 提取逻辑，只写内部 `codex.model_fallback` 观测事件。
- 不能降级或候选耗尽：恢复原始错误事件，并按现有失败协议结束。

对外协议保持不变：

- 请求字段不变。
- SSE 事件类型和顺序约束不变。
- 非流式响应结构不变。
- 对外 `model` 字段继续保持调用方请求的模型，不暴露实际后备模型。

## 可观测性

每次内部切换记录一条结构化日志或内部 job 事件，至少包含：

- `requested_model`
- `attempted_model`
- `next_model`
- `attempt_index`
- `failure_class`
- `http_status`（可用时）
- `req_id`、`job_id`、`user_id`、`session_id`

最终成功时记录 `successful_model` 和总尝试次数。不得记录 token、完整 prompt、完整用户内容或账号邮箱。

## 测试

### 配置测试

- 未配置和空链保持 fallback 关闭。
- 正确解析模型顺序和 reasoning effort。
- 空模型名或非法 effort 导致明确配置错误。
- preset 解析后按实际模型名去重。

### Runner 单元测试

- Luna capacity 后 Terra 成功。
- Luna capacity、Terra capacity 后 5.5 成功。
- 原始 gpt-5.4 不可用后进入完整降级链。
- 原始模型位于链中时从下一模型继续。
- 429、502、503、504 的模型采样错误允许降级。
- unsupported、not-found、entitlement 错误允许降级。
- 鉴权、权限、工具、超时和取消错误不降级。
- 已产生文本、工具活动、文件修改或交互请求时不降级。
- failed turn 回滚失败时停止。
- 所有候选失败时返回最后一次真实错误。
- 中间模型错误不进入调用方 SSE。

### API 回归测试

- `/v1/responses` 流式协议快照不变。
- 非流式响应结构不变。
- 对外 `model` 仍是请求模型。
- 现有 preset 与会话持久化行为不变。

### 真实冒烟测试

在 8810 使用一个明确不可用的首选模型发起最小请求，验证 Ripple 自动切换并正常返回回答；随后检查内部日志确认尝试顺序。真实测试不能依赖 Luna 恰好 capacity，应使用可控的测试错误或明确不支持的测试模型触发第一跳。

## 部署与回退

- 构建并运行 Ripple Rust 测试。
- 在测试配置中加入 fallback 链后重启 Ripple Server。
- 运行健康检查、模型冒烟和 NextGen 原协议冒烟。
- 回退时先移除 `fallback_chain` 即可关闭功能；代码保留时缺省行为与当前版本一致。
