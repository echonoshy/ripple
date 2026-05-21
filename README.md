<div align="center">

<img src="assets/ripple-icon.svg" alt="Ripple Logo" width="96" />

# Ripple

运行在 Codex app-server 之上的 Agent 控制面。

**状态：WIP。** 后端正在从 Python/FastAPI 迁移到 Rust。

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

Python 后端：

```bash
uv run ripple
```

Rust 后端：

```bash
cargo run -p ripple-server
```

Web 客户端：

```bash
cd src/interfaces/web
bun run dev
```

## 验证

```bash
cargo check -p ripple-server
cargo test -p ripple-server
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
