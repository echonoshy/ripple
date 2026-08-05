# Ripple Server Model Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 NextGen 协议的前提下，让 Ripple Server 在无输出、无副作用的模型不可用错误后按 Luna low、Terra low、GPT-5.5 low 的顺序自动降级。

**Architecture:** `AppConfig` 解析可选 fallback 链，Codex runner 将原始模型与配置链合并去重，并在同一个 job 内执行多个 turn attempt。`collect_turn` 保留结构化失败、暂存终止错误通知并跟踪副作用；只有模型级且无副作用的失败才回滚失败 turn 并尝试下一模型。

**Tech Stack:** Rust 1.77.2、Tokio、serde/serde_yaml、Codex app-server JSON-RPC、Axum SSE、Cargo test

## Global Constraints

- 只修改 `/root/ripple`，不修改 NextGen 代码或调用协议。
- 不新增对外 SSE 事件或响应字段；对外 `model` 保持调用方请求值。
- fallback 顺序由 `model.fallback_chain` 配置，缺失或为空时保持当前行为。
- 仅 capacity、unsupported/not-found、entitlement/access，以及模型采样阶段的 429/502/503/504 可降级。
- 已输出文本、启动工具/文件操作、请求 approval/user input、鉴权失败、权限失败、超时或取消时不得降级。
- 工作树已有用户未提交修改；每次编辑前复核目标 diff，只提交本任务相关 hunks。
- Commit 使用 `[TAG] 中文描述`，不得直接向 `main`/`master` 推送。

---

### Task 1: 配置模型 fallback 链

**Files:**
- Modify: `crates/ripple-server/src/config.rs`
- Modify: `config/settings.yaml.sample`
- Test: `crates/ripple-server/src/config.rs` 内 `mod tests`

**Interfaces:**
- Produces: `AppConfig::model_fallback_chain: Vec<ModelFallback>`
- Produces: `ModelFallback { model: String, reasoning_effort: Option<String> }`
- Produces: `AppConfig::model_attempts(&self, model: String, effort: Option<String>) -> Vec<ModelAttempt>` 或等价纯函数；按实际模型名去重。

- [ ] **Step 1: 写配置解析失败测试**

增加测试覆盖缺省空链、三项顺序、空 `model`、非法 `reasoning_effort`：

```rust
#[test]
fn parses_model_fallback_chain_in_order() {
    let config = with_temp_config(
        "model-fallback",
        "model:\n  fallback_chain:\n    - model: gpt-5.6-luna\n      reasoning_effort: low\n    - model: gpt-5.6-terra\n      reasoning_effort: low\n    - model: gpt-5.5\n      reasoning_effort: low\nserver:\n  api_keys: [test-key]\n",
        AppConfig::load,
    ).expect("load config");
    assert_eq!(config.model_fallback_chain.len(), 3);
    assert_eq!(config.model_fallback_chain[0].model, "gpt-5.6-luna");
}
```

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `cargo test -p ripple-server config::tests::parses_model_fallback_chain_in_order -- --exact`

Expected: FAIL，原因是 `fallback_chain` 尚未进入配置结构。

- [ ] **Step 3: 实现配置类型、解析和校验**

新增：

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelFallback {
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawModelFallback {
    model: Option<String>,
    reasoning_effort: Option<String>,
}
```

在 `RawModel` 增加 `fallback_chain: Option<Vec<RawModelFallback>>`，加载时清理模型名并校验 effort 只能是 `low|medium|high|xhigh`。空模型或非法 effort 返回带索引的配置错误。

- [ ] **Step 4: 实现候选链去重测试与纯函数**

测试原始 `gpt-5.4` 得到四项、原始 Luna 跳过 Luna、preset 解析后的 `gpt-5.5` 不再追加任何候选。去重键使用 `model`，保留第一次出现的 effort。

- [ ] **Step 5: 更新示例配置并运行测试**

Run: `cargo test -p ripple-server config::tests`

Expected: PASS。

- [ ] **Step 6: 提交配置能力**

```bash
git add -p crates/ripple-server/src/config.rs config/settings.yaml.sample
git commit -m '[ADD] 配置模型自动降级链'
```

---

### Task 2: 保留结构化 turn 失败并判定是否可降级

**Files:**
- Modify: `crates/ripple-server/src/codex/app_server.rs`
- Modify: `crates/ripple-server/src/codex/app_server/protocol.rs`
- Test: `crates/ripple-server/src/codex/app_server.rs` 内 `mod tests`

**Interfaces:**
- Consumes: `ModelAttempt` 与 `AppConfig::model_attempts`
- Produces: `TurnFailure { message, http_status, class, retry_safe, buffered_notifications }`
- Produces: `classify_model_failure(error: &Value) -> Option<ModelFailureClass>`
- Produces: `turn_activity_blocks_fallback(message: &Value) -> bool`

- [ ] **Step 1: 写结构化错误提取测试**

构造 Codex `turn/completed`：

```rust
json!({
  "method": "turn/completed",
  "params": {"turn": {
    "status": "failed",
    "error": {
      "message": "Selected model is at capacity. Please try a different model.",
      "codexErrorInfo": {"httpStatusCode": 503}
    }
  }}
})
```

断言分类为 capacity、状态码为 503，且错误消息不再变成 `codex turn failed`。

- [ ] **Step 2: 写不可降级错误和副作用测试**

覆盖 auth、sandbox、timeout、cancel、普通工具错误；覆盖 `agentMessage` delta、非只读 tool item、approval、request-user-input 后 `retry_safe == false`。

- [ ] **Step 3: 运行定向测试并确认失败**

Run: `cargo test -p ripple-server codex::app_server::tests::model_failure -- --nocapture`

Expected: FAIL，原因是尚无结构化失败分类。

- [ ] **Step 4: 实现纯解析和分类函数**

优先读取 `/params/turn/error`，兼容先到达的 `error` / `turn/error` 通知。状态码只从 `codexErrorInfo.httpStatusCode` 读取；消息匹配只覆盖设计文档列出的模型级词组，不用泛化的 `server_error`。

- [ ] **Step 5: 实现活动跟踪与终止通知缓冲**

`collect_turn` 对 terminal `error`/`turn/error` 与 failed completion 暂存；其他事件继续按原顺序写入。记录 assistant 文本、工具、文件、approval、user-input 和外发控制事件是否出现。

- [ ] **Step 6: 运行 app_server 单元测试**

Run: `cargo test -p ripple-server codex::app_server::tests`

Expected: PASS。

- [ ] **Step 7: 提交结构化失败能力**

```bash
git add -p crates/ripple-server/src/codex/app_server.rs crates/ripple-server/src/codex/app_server/protocol.rs
git commit -m '[REFACTOR] 保留Codex结构化失败信息'
```

---

### Task 3: 在同一个 Runner job 内完成模型降级

**Files:**
- Modify: `crates/ripple-server/src/codex/app_server.rs`
- Test: `crates/ripple-server/src/codex/app_server.rs` 内 `mod tests`
- Test: `crates/ripple-server/tests/api_smoke.rs`

**Interfaces:**
- Consumes: Task 1 的候选模型链。
- Consumes: Task 2 的 `TurnFailure` 与 `retry_safe`。
- Produces: 单 job attempt loop、失败 turn 清理、`thread/rollback`、内部 `codex.model_fallback` 事件。

- [ ] **Step 1: 写 attempt 顺序和停止条件测试**

用 fake app-server 脚本驱动以下序列：Luna capacity → Terra completed；Luna capacity → Terra 503 → 5.5 completed；首轮已有 tool item 后失败时不启动第二 turn。

- [ ] **Step 2: 运行测试并确认失败**

Run: `cargo test -p ripple-server model_fallback -- --nocapture`

Expected: FAIL，只观察到一次 turn attempt。

- [ ] **Step 3: 重构 `run_turn` 返回 attempt 结果**

无论成功或失败都返回 `thread_id`、`turn_id` 和 outcome，使 runner 能在下一 attempt 前执行：

```rust
session.unregister_turn(&thread_id, &turn_id).await;
self.clear_job_transient_state(job_id).await;
self.active_turns.lock().await.remove(job_id);
```

- [ ] **Step 4: 实现失败 turn 回滚**

只对 `retry_safe` 的模型级错误调用：

```rust
session.request("thread/rollback", json!({
    "threadId": thread_id,
    "numTurns": 1
})).await?;
```

回滚失败时恢复缓存的原始错误事件并停止，不尝试下一模型。

- [ ] **Step 5: 实现候选循环和内部观测事件**

每次切换写 `codex.model_fallback`，数据只包含模型、attempt、失败分类、状态码和既有关联 ID。最终成功时写内部 `codex.model_fallback.completed`；不得修改对外响应使用的请求模型。

- [ ] **Step 6: 验证 SSE 静默与最终失败**

增加 API 测试断言中间 capacity 文案和内部事件不出现在响应体；候选耗尽时只出现最后一次真实错误，既有 SSE shape 不变。

- [ ] **Step 7: 运行定向与回归测试**

Run:

```bash
cargo test -p ripple-server model_fallback -- --nocapture
cargo test -p ripple-server api_smoke -- --nocapture
```

Expected: PASS。

- [ ] **Step 8: 提交 Runner 降级**

```bash
git add -p crates/ripple-server/src/codex/app_server.rs crates/ripple-server/tests/api_smoke.rs
git commit -m '[ADD] Codex模型不可用时自动降级'
```

---

### Task 4: 启用测试机配置并完成验证

**Files:**
- Modify, do not commit: `config/settings.yaml`
- Verify only: `/root/ripple`

**Interfaces:**
- Consumes: Tasks 1–3 的配置和 runner 行为。
- Produces: 8810 启用 Luna low → Terra low → GPT-5.5 low 的运行配置和验证证据。

- [ ] **Step 1: 在正式配置加入 fallback 链**

只修改 `model.fallback_chain`，不输出或改动 API key、token 和 connector credential。

- [ ] **Step 2: 格式、编译和全量测试**

Run:

```bash
cargo fmt -p ripple-server -- --check
cargo check -p ripple-server
cargo test -p ripple-server
git diff --check
```

Expected: 全部退出码 0；既有无关 clippy 警告不作为本任务验证项。

- [ ] **Step 3: 构建并按现有运行方式重启 8810**

先确认当前 tmux 进程、配置路径和新二进制，再用仓库既有部署流程替换；禁止手工制造第二个监听 8810 的孤儿进程。

- [ ] **Step 4: 健康与模型 fallback 冒烟**

验证：

```text
GET /health                         -> 200
GET /v1/health/ready               -> status=ready
不可用原始模型的 /v1/responses     -> 200 且正常回答
Ripple 内部日志                     -> 按配置顺序记录 fallback
外部 SSE                            -> 不包含模型切换事件
```

- [ ] **Step 5: NextGen 原协议冒烟**

使用现有 `/via-gateway/v1/chat/completions` 请求，不增加字段；确认请求成功或在所有候选失败时收到原有错误 shape。

- [ ] **Step 6: 最终提交检查**

确认 `config/settings.yaml`、备份文件、运行日志和用户数据未被加入 Git。报告本任务 commits、验证命令及实际 fallback 结果。
