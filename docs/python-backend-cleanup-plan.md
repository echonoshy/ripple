# Python Backend Cleanup Plan

本文记录 Rust 后端替换 Python/FastAPI 后端后的清理边界、已执行内容和剩余验证事项。

## Current Status

- Rust 后端已经覆盖 Python FastAPI 的主要 `/v1` API 表面：chat、sessions、workspace、connectors、runs、schedules、documents、users、sandbox、approval、schedule trigger 和 connector auth。
- 当前 Rust 校验通过：`cargo test -p ripple-server` 包含 26 个单元测试和 24 个 `api_smoke` 路由/集成测试。
- 还不能宣称迁移完全结束。仍需要补足真实环境硬化：
  - 真实 Codex schedule extraction 输出和老客户端 UI flow 的端到端验证。
  - 真实 nsjail runtime 下 connector CLI auth/status flow 的端到端验证。
- Python/FastAPI 后端和 `src/ripple` legacy 控制面已删除，不再作为参考实现或新增能力入口。

## Cleanup Executed

- Removed `src/interfaces/server/`, the FastAPI backend API surface.
- Removed `src/ripple/`, the legacy Python control-plane/runtime package.
- Removed Python-only route/runtime tests under `tests/`.
- Removed root Python packaging and lock files: `pyproject.toml` and `uv.lock`.
- Removed the ignored local `.venv` that contained old Python backend dependencies.
- Updated project docs and quickstarts so local development points at `cargo run -p ripple-server`.

## What To Keep

- 保留 `src/skills/**/pipeline.py` 和 skill 目录内的 Python helper scripts。项目约定允许 skill 内部继续使用 Python helper，它们不属于后端迁移残留。
- 保留 skill 目录内的 helper 自测脚本，前提是这些测试不依赖 Python FastAPI 后端。
- 保留 Rust 侧 `/v1/tasks` 410 兼容响应，直到确认没有老客户端依赖该路径。

## Cleanup Phases

### Phase 1: Freeze And Remove Python API Surface

- Status: completed.
- Updated docs to make Rust the default control plane:
  - `README.md` 不再把 `uv run ripple` 作为常规启动方式。
  - `docs/rust-backend-migration.md` 修正过期的 “Python FastAPI remains the production backend” 表述。
  - `src/interfaces/mobile/README.md` 把 “FastAPI server” 改为 Ripple Server `/v1`。
- Deleted `src/interfaces/server/` FastAPI backend implementation.
- Deleted Python API route tests covered by Rust smoke tests.
- Removed root Python backend dependencies and `ripple = "interfaces.server.app:main"`.

### Phase 2: Remove Python Control-Plane Runtime

- Status: completed.
- Deleted `src/ripple/agent_runners/` Python Codex app-server provider, job store, manager, and service.
- Deleted `src/ripple/connectors/registry.py` and old connector web route support.
- Deleted Rust-owned data and schedule layers:
  - `src/ripple/schedules.py`
  - `src/ripple/documents/`
  - `src/ripple/users/`
  - old sandbox/session storage support code not used by `src/skills` helpers.

### Phase 3: Remove Legacy Model-Facing Runtime

- Status: completed.
- Deleted old model-facing tool/skill runtime:
  - `src/ripple/tools/`
  - `src/ripple/permissions/`
  - `src/ripple/core/context.py`
  - `src/ripple/skills/executor.py`
  - `src/ripple/skills/skill_tool.py`
- Confirmed `src/skills` helper scripts do not import the removed `ripple.*` modules.
- Skill manifest rendering is owned by Rust `crates/ripple-server/src/skills.rs`.

### Phase 4: Remove Python Tooling Residue

- Status: completed for backend tooling.
- Deleted Python-only backend/runtime tests.
- Removed `uv.lock` and root Python backend dependencies.
- If future skill helper tests need a common runner, add minimal skill-only Python tooling instead of restoring the backend package.

## Validation

Rust 主链路验证：

```bash
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
cd src/interfaces/web && bun run build
```

仍建议补充真实环境 smoke：

```text
- 一次真实 Codex /v1/chat/completions streaming。
- 一次真实 schedule 创建、确认和触发。
- Google Workspace 或 Feishu 至少一个真实 connector auth/status flow。
```

删除 Python 残留后执行引用扫描：

```bash
rg "interfaces.server|uv run ripple|FastAPI|src/ripple/agent_runners|src/ripple/tools"
```

删除后再次验证：

```bash
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
cd src/interfaces/web && bun run build
```

## Assumptions

- Rust 后端将作为唯一后端控制面。
- Python skill helper 继续允许存在，不纳入后端残留清理范围。
- Codex app-server 仍是唯一执行面，Ripple 只负责控制面。
- `/v1/tasks` 的 Rust 侧 410 兼容响应暂时保留。
