# TaskSession model / effort Implementation Plan

**Goal:** 让 TaskSession 的解析和执行链路按 Chat 的规则解析并传递 model / effort。

**Architecture:** 在 `task_sessions.rs` 增加一个无副作用的配置解析函数，从请求、会话、服务配置中选值，再委托 `AppConfig::resolve_model`。TaskSpec extraction 与 TaskRun execution 共同调用该函数。

**Tech Stack:** Rust, Axum, serde_json, cargo test

---

### Task 1: 更新接口文档

**Files:**
- Modify: `docs/VIA_GATEWAY_TASK_CENTER_API.md`

记录创建、消息、确认三个入口的字段和覆盖优先级，并说明 TaskSession 响应回显会话默认值。

### Task 2: 增加失败测试

**Files:**
- Modify: `crates/ripple-server/src/api/task_sessions.rs`

为 preset 解析、请求覆盖、会话覆盖、默认回退和公共投影编写单元测试。先运行定向测试并确认因缺少实现而失败。

### Task 3: 实现统一解析

**Files:**
- Modify: `crates/ripple-server/src/api/task_sessions.rs`

增加共用解析函数；在 TaskSpec extraction 和 Ripple execution 创建 `AgentRunCreateRequest` 时使用解析结果；公共 TaskSession 投影复制 `model`、`effort`。

### Task 4: 验证

运行：

```bash
cargo fmt -p ripple-server -- --check
cargo test -p ripple-server task_session_model_effort
cargo test -p ripple-server task_sessions
cargo check -p ripple-server
git diff --check
```
