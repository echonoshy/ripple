<div align="center">

<img src="assets/ripple-icon.svg" alt="Ripple Logo" width="96" />

# Ripple

运行在 Codex app-server 之上的 Agent 控制面。

**状态：WIP。** 后端正在从 Python/FastAPI 迁移到 Rust；当前本地开发优先使用 Rust 后端，Python 后端保留为参考实现。

</div>

## 项目定位

Ripple 负责管理多用户、session、sandbox、connector 授权、skill manifest、approval state 和 Codex job lifecycle。

执行层仍然是 Codex app-server。Web、Tauri 和其他客户端只调用 Ripple Server API，不承载后端业务逻辑。

## 当前方向

- Rust 后端目标：`crates/ripple-server`
- Python 参考后端：`src/interfaces/server`
- Web / Tauri 客户端：`src/interfaces/web`
- 共享 skills：`src/skills`
- 运行时数据：`.ripple/`

更多产品和架构说明后续放到 `sites/`。

## 运行

1. 准备配置：

```bash
cp config/settings.yaml.sample config/settings.yaml
```

至少把 `server.api_keys` 改成本地 API key。需要真实 Codex 执行时，按示例配置里的 `external_agents.codex.codex_home` 登录服务端 Codex：

```bash
CODEX_HOME=.ripple/codex-service-home codex login
```

2. 启动 Rust 后端：

```bash
cargo run -p ripple-server
```

Rust 服务默认监听 `http://127.0.0.1:8810`（配置里是 `0.0.0.0:8810`），Web 开发代理默认转发 `/v1` 到这个端口。

3. 启动 Web 客户端：

```bash
cd src/interfaces/web
bun run dev
```

Python 后端仍可作为兼容参考启动：

```bash
uv run ripple
```

## 验证

```bash
cargo check -p ripple-server
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
uv run pytest
```

前端：

```bash
cd src/interfaces/web
bun run lint
bun run build
```

## 文档

- 开发依据：[AGENTS.md](AGENTS.md)
- Rust 后端迁移：[docs/rust-backend-migration.md](docs/rust-backend-migration.md)
- Skills：[docs/SKILLS.md](docs/SKILLS.md)
