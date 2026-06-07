# AGENTS.md

本文件是 OpenAI Codex / Codex CLI 在本仓库工作的项目级入口。后续开发判断优先以这里为准。

## 优先级

- 用户当前请求和系统/开发者指令优先级最高。
- 本文件是唯一项目级 Agent 指南；不要再依赖其他旧 Agent 说明文件。
- 如果子目录存在更近的 `AGENTS.md`，在该子目录工作时同时遵守子目录说明。

## 项目定位

**ripple** 是运行在 Codex app-server 之上的 Agent 控制面。

核心职责：

- 管理多用户、session、run、workspace、sandbox、connector 授权、skill manifest、approval bridge 和 API 边界。
- 把实际执行委托给服务端 Codex app-server。
- 为 Web / Tauri / Mobile 等客户端提供统一 `/v1` API。

关键边界：

- 后端是独立 Linux 服务，不嵌入 Tauri 客户端。
- 前端和 App 都只是客户端；不要把服务端业务逻辑放进前端。
- 后端必须保持多用户模型。`X-Ripple-User-Id` 是 user 隔离入口。
- sandbox 以 `user_id` 为隔离单位，不以 session 为隔离单位。
- Codex app-server 是执行面；Ripple 是控制面。
- Skills 继续是 Markdown/YAML frontmatter；skill 内部需要 Python helper 时可以继续保留 Python。

## 当前后端方向

后端控制面由 Rust 实现；旧 Python/FastAPI 后端和 legacy Python `ripple` 控制面已清理。Python 只作为部分 skill helper 的实现语言保留。

- Rust 后端：`crates/ripple-server`
- Rust 后端要保持 Web / Tauri / Mobile 客户端依赖的 `/v1` response shape、SSE 事件、session 状态和 connector auth 流程稳定。
- 迁移状态文档：`docs/rust-backend-migration.md`

已经迁移到 Rust 的主要后端能力：

- 配置加载、API key middleware、`X-Ripple-User-Id` 校验。
- user sandbox 目录、session metadata/messages、workspace 文件 API、documents、users/quota。
- connector list/status/auth/disconnect/accounts。
- Notion token、Google Workspace OAuth、Feishu/Lark auth、Bilibili QR auth。
- Codex app-server JSON-RPC provider，按 job 启动可信服务端进程；job 完成后关闭，chat 连续上下文依赖持久 Codex thread id。
- `/v1/runs`、`/v1/chat/completions`、Codex approval bridge。
- chat 侧 connector auth 拦截、轮询和授权后自动恢复。
- schedule CRUD、run history、run-now、后台 due schedule trigger。
- Codex managed permissions profile、服务端 Codex auth deny-read、skill manifest。

仍需重点补齐：

- chat 侧 schedule creation 在真实 Codex extraction 输出和老客户端 UI flow 下的端到端硬化。
- 真实 nsjail runtime 下 connector CLI auth/status flow 的端到端硬化。
- 老客户端如果仍需要的 deprecated compatibility API，例如 `/v1/tasks`。

## 主要目录

```text
crates/
  ripple-server/       # Rust 后端迁移目标
    src/api/           # /v1 API routes
    src/codex/         # Codex app-server provider、approval、permissions
    src/sandbox.rs     # user sandbox 路径与运行时目录
    src/sessions.rs    # session store
    src/jobs.rs        # run/job store
src/
  interfaces/
    app/               # Vite + React 主 App 客户端，含 Tauri desktop/iOS/Android shell
  skills/              # 共享 skills，部分 skill 可带 Python helper
docs/                  # 开发文档
sites/                 # 面向展示/产品说明的站点内容
config/                # YAML 配置
scripts/               # CLI 安装和维护脚本
```

## 常用命令

Rust 后端：

```bash
cargo run -p ripple-server
cargo fmt -p ripple-server
cargo check -p ripple-server
cargo test -p ripple-server
```

说明：`cargo clippy -p ripple-server -- -D warnings` 当前还有少量既有 clippy 警告，不能作为全仓阻塞校验；如果触碰相关代码，可以顺手清理，但不要把无关大清理混入迁移提交。

App / Tauri 客户端：

```bash
cd app
bun run dev
bun run build
bun run lint
bun run format:check
bun run tauri:dev
```

## 编码纪律

- 优先保持当前主链路清晰、简单、可验证；不要为了旧实现保留过多兼容层。
- 工作树可能已有用户改动；不要回滚与当前任务无关的改动。
- 遇到失效 legacy 代码、配置、脚本或文档时，先说明清理范围、原因和影响，再动手。
- 新增或更新文档时，同步检查相关旧文档是否过时。
- 配置统一放 `config/*.yaml`，不要新增 `.env`。
- 不要提交 `config/settings.yaml`、`.ripple/`、API key、token、OAuth credential、cookie 或任何敏感信息。
- 路径操作优先用结构化 API：Rust 用 `Path` / `PathBuf`；skill helper 如使用 Python，则用 `pathlib`。
- 遇到数据解析问题，优先使用结构化 parser，不要用脆弱字符串拼接或临时正则绕过去。

Rust 规则：

- `crates/ripple-server` 的 MSRV 见 `crates/ripple-server/Cargo.toml`，当前为 Rust `1.77.2`；不要使用超过 MSRV 的标准库 API。
- API response shape 要优先对齐前端实际消费方式和已记录的 `/v1` 兼容行为。
- 涉及运行时状态时，先确认 `.ripple/sandboxes/<user_id>/...` 的磁盘布局。
- 修改 Rust 后至少运行 `cargo fmt -p ripple-server`、`cargo check -p ripple-server`，按风险运行 `cargo test -p ripple-server`。

Python helper 规则：

- Python 仅用于 `skills` 下的 helper、脚本和资源处理，不恢复后端控制面或 model-facing tool runtime。
- 使用内置泛型注解，如 `list[str]`、`dict[str, str]`。
- 不要新增无必要的 `__init__.py`。
- 不要新增 `from __future__ import annotations`。

前端规则：

- App/Tauri 只做客户端展示和交互，不承载后端控制面能力。
- 前端只调用 Ripple Server `/v1` API。
- API 地址按运行位置区分：部署在与 `ripple-server` 同一台机器上的 Web 服务可以通过 `localhost` / `127.0.0.1` 访问后端；在开发者本地 Mac 或其他非后端机器上打包、运行、调试的客户端不能依赖 `localhost`，尤其是 iOS/Tauri mobile/TestFlight、Android 和独立桌面客户端，必须显式使用 `http://140.143.229.103:8810/v1`，除非后端恢复 HTTPS 域名或另行提供可从设备访问的地址。
- 临时打包链路：在 `test-oauth.weilai.ai` 解除腾讯云备案/域名拦截前，Web / macOS / iOS / Android 客户端生产默认 API 暂时指向 `http://140.143.229.103:8810/v1`。这是为了先跑通链路的 HTTP IP 直连方案；恢复 HTTPS 域名时，同步回滚前端默认 API、Tauri CSP、macOS/iOS ATS 明文例外和 Android cleartext 配置。
- 客户端产品形态以真实终端用户体验为主；除非明确要做 Ripple 控制面/管理台，不要把其他 App 默认设计成“工作台”壳子。优先围绕用户能完成的核心任务、移动触控、信息密度、关键流程和功能体验来组织界面。
- 项目内图标和同类视觉资源默认使用 `lucide-react` 的线性图标风格，保持统一尺寸、描边粗细、视觉重量和交互状态；不要混用风格差异明显的图标来源。
- 修改前端后在 `app` 运行 `bun run lint`、`bun run build` 或相应最小验证。
- UI 变更优先保持现有 Vite + React + Tauri 结构，不引入新的前端框架。

App 设计语言：

- Ripple App 的产品气质参考飞书 / Lark 的协作工具设计语言，而不是营销站、消费级社交 App 或传统后台管理台。参考的是信息架构、交互节奏、移动触控和动效原则，不复制飞书品牌资产、商标或专有视觉。
- 官方参考：
  - Universe Design 概述：`https://open.feishu.cn/document/design-specification/written-in-advance?lang=zh-CN`
  - 飞书导航规范：`https://open.feishu.cn/document/tools-and-resources/design-specification/gadget-design-specification/visual-specifications/navigation?lang=zh-CN`
  - 飞书动效规范：`https://open.feishu.cn/document/design-specification/design-language/animation?lang=zh-CN`
  - 飞书字体规范：`https://open.feishu.cn/document/design-specification/design-language/font?lang=zh-CN`
- 移动端默认采用“一级页面底部 Tab + 二级/详情页顶部返回”的结构。非一级页面必须有清晰可点的返回入口；可以增加手势返回，但不能只依赖隐藏手势。
- 移动端手势按飞书式协作 App 习惯处理：纵向滚动优先，左边缘右滑返回优先；非边缘区域必须提高横滑阈值，避免聊天流、列表、文档内容因为轻微斜滑误触返回。
- `touch guard` 或滚动锁只用于确认横向意图的短暂阶段；一旦手势明显转为纵向滚动，必须释放滚动锁并停止继续 `preventDefault()`。
- iOS 和 Android 共用的 WebView 手势逻辑要保持一致；Android 如果自定义左边缘返回手势，需要同步更新原生 `systemGestureExclusionRects` 范围，避免系统返回手势抢占 App 内返回。
- 动效遵循“快速响应、缓慢结束”：用户直接拖动的对象要跟手，释放后的回弹/提交动画要短、顺、可预测；关闭/退出通常比进入更快。现有 `motionPrimitives.ts` 是移动动效参数的优先来源。
- 列表、聊天、文件、设置等高频工作流优先保证扫描效率、触控热区和稳定布局。避免大面积装饰、过度卡片化、强品牌渐变、复杂背景和会降低信息密度的视觉噪声。
- 字体层级保持克制：正文和列表优先使用当前 `stylePrimitives.ts` 的 14/16px 等级，标题只用于页面级语义；不要在紧凑面板、卡片或工具条内使用 hero 级字号。
- 图标继续使用 `lucide-react` 线性风格。图标按钮要有明确 `aria-label` / `title`，尺寸、描边和视觉重量与当前 App 保持一致。
- 做移动 UI 或手势变更后，除 `bun run lint`、`bun run build` 或最小测试外，还应人工列出需要真机验证的 iOS / Android 场景，例如边缘返回、纵向滚动、键盘弹出、底部安全区、Android 系统返回手势竞争。

## 配置

- 主配置文件：`config/settings.yaml`
- 示例配置：`config/settings.yaml.sample`
- `RIPPLE_CONFIG` 可指定配置路径。
- API key、模型、Codex、connector、skill、server 参数放在 YAML 配置中。
- 前端配置集中在 `app/package.json`、`vite.config.ts`、`eslint.config.mjs`、`tsconfig.json`。

## Server / Codex 链路

Ripple 采用控制面 / 执行面分离：

- **Ripple Control Plane**：API、鉴权、user/session/sandbox lifecycle、connector auth/status、skill manifest、approval bridge、job/event/output 状态。
- **Codex Execution Plane**：服务端预装 `codex app-server --listen stdio://`，由 Ripple 按 job 启动为可信服务端进程；job 完成后关闭。

Codex 授权是服务端统一授权，不是 per-user Codex 授权：

- 生产建议为服务端 Codex 配置独立 `CODEX_HOME`，例如 `.ripple/codex-service-home`。
- 不要把 Codex `auth.json` 复制、挂载或保存到 `sandboxes/<uid>/workspace/`。
- user sandbox 只保存用户文件和 per-user connector 凭证。
- `run_app_server_in_user_sandbox` 默认必须为 `false`。
- Connector 状态检查应使用与 app-server 相同的 codex home/env 语义，避免“状态已登录、执行未登录”。
- 默认链路必须使用 Codex managed permissions profile：根目录只读、project roots 可写、服务端 Codex auth 路径 deny-read，并从 shell env 排除 `CODEX_HOME`。

`/v1/chat/completions` 主链路：

1. Server 校验 API key，读取 `X-Ripple-User-Id`。
2. 创建或恢复当前 user 的 session 和 workspace。
3. chat 侧先处理 connector auth、schedule 等控制面事件。
4. 构建 Codex-facing prompt，注入 Ripple/Codex 角色说明、session 历史、connector 状态、skill manifest。
5. 启动 Codex app-server job，并以当前 user workspace 为 cwd。
6. Codex 通过 managed permissions profile 限制读写。
7. Ripple 收集 Codex event/output，转换为 OpenAI-compatible response 或 SSE，并持久化 session。

`/v1/runs` 是独立 Codex job API，适合外部调度器或前端长任务详情页。

当前明确不走的旧链路：

- 不恢复旧 `agent_loop` / `QueryState` / OpenRouter/OpenAI client 主循环。
- 不把 Bash/Read/Write 作为 Ripple server model-facing tools 暴露给模型。
- `/v1/tools/invoke` 属于 legacy compatibility，不应作为新能力入口。

## User 沙箱模型

- 隔离单位是 `user_id`，不是 session。
- 同一 user 的多个 session 共享同一个长期 workspace。
- 同一 user 的多个 session 和 `/v1/runs` 可以并行执行，共享同一个 workspace；不要新增 user 级执行锁来串行化任务。
- Rust 侧只对同一 session 的 chat、context compaction 等链路做 session 级互斥。共享 workspace 的并发写入语义由任务自身和客户端流程处理。
- 调用方通过 HTTP header `X-Ripple-User-Id: <uid>` 传入 user_id。
- 缺失 header 时回落到 `default`。
- `user_id` 合法字符集为 `[a-zA-Z0-9_-]{1,64}`。
- Ripple 不做最终身份鉴权，由上游业务系统保证 user_id 的真实性和隔离语义。

运行时目录 `.ripple/` 由 Server 首次运行创建，不纳入版本控制：

```text
.ripple/
├── sandboxes-cache/
└── sandboxes/
    └── <user_id>/
        ├── workspace/
        ├── nsjail.cfg
        ├── credentials/
        │   ├── feishu.json
        │   ├── notion.json
        │   ├── gogcli-client.json
        │   ├── gogcli-keyring.pass
        │   └── bilibili.json
        └── sessions/
            └── <session_id>/
                ├── meta.json
                ├── messages.jsonl
                ├── tasks.json
                └── task-outputs/
```

## Connector 约定

当前主要 user connector：

- Google Workspace：通过 `gog`，部署级 OAuth Client + per-user refresh token。
- Notion：用户粘贴 integration token，保存到当前 user credentials。
- Feishu/Lark：通过 `lark-cli`，支持 app config seeding、setup URL、user auth。
- Bilibili：二维码登录，凭证保存到当前 user credentials。

外部 CLI 通过 `vendor/` 托管，沙箱中 readonly bind-mount 到 `/opt/<name>/`：

| CLI | 安装脚本 | 宿主安装位置 | 沙箱路径 |
| --- | --- | --- | --- |
| `lark-cli` | `bash scripts/install-feishu-cli.sh` | `vendor/lark-cli/v<X.Y.Z>/bin/` | `/opt/lark-cli/current/bin/lark-cli` |
| `ntn` | `bash scripts/install-notion-cli.sh` | `vendor/notion-cli/v<X.Y.Z>/bin/` | `/opt/notion-cli/current/bin/ntn` |
| `gog` | `bash scripts/install-gogcli-cli.sh` | `vendor/gogcli-cli/v<X.Y.Z>/bin/` | `/opt/gogcli-cli/current/bin/gog` |

Google Workspace 约定：

- 使用任何 gog 能力前，先读 `skills/gog/gog-shared/SKILL.md`。
- 当前支持服务：`gmail, drive, calendar, docs, sheets, slides`。
- 授权入口：`/v1/connectors/google_workspace/auth/start`。
- 状态/账号检查：`/v1/connectors/google_workspace/accounts?check=true`。
- Codex 执行业务时在当前 user workspace 内调用 `gog`。
- 每条 gog 命令必须显式指定账号，例如：

```bash
gog --account <email> --json gmail search "newer_than:7d" --max 5
```

破坏性 connector 操作必须先让用户明确确认，尤其是：

- Gmail send/reply/forward/delete
- Drive delete/share/unshare/replace
- Calendar create/update/delete/respond
- Docs write/sed/find-replace
- Sheets update/clear/delete-tab
- Slides create/copy/find-replace/batch-update
- connector logout / disconnect

## Skill 系统

Skills 是带 YAML frontmatter 的 Markdown 文件。

加载层级：

1. Shared Skills：默认来自 `skills/*`。
2. Workspace Skills：来自每个 user workspace 内的 `skills/`。

Codex-only runtime 下，Ripple 主要把 skill manifest 注入 prompt，而不是通过 `SkillTool` 让模型回调 Server。

约定：

- `SKILL.md` 是 skill 的入口。
- skill 可以附带 Python helper、脚本和资源文件。
- helper 路径应相对 skill 自身目录，不要写本机绝对路径。
- Codex 看到 manifest 后，应自行读取对应 `SKILL.md` 和相邻资源文件。

详细文档：`docs/SKILLS.md`

## 架构索引

Rust 后端：

- `crates/ripple-server/src/main.rs`：Rust server entrypoint。
- `crates/ripple-server/src/api/mod.rs`：route 注册。
- `crates/ripple-server/src/api/chat.rs`：OpenAI-compatible chat bridge、chat-side connector auth。
- `crates/ripple-server/src/api/runs.rs`：Codex run API。
- `crates/ripple-server/src/api/connectors.rs`：connector status/auth/disconnect/accounts。
- `crates/ripple-server/src/codex/app_server.rs`：Codex app-server JSON-RPC provider。
- `crates/ripple-server/src/codex/permissions.rs`：Codex managed permissions profile。
- `crates/ripple-server/src/sandbox.rs`：user sandbox path/config。
- `crates/ripple-server/src/sessions.rs`：session store。
- `crates/ripple-server/src/jobs.rs`：job store、event/output persistence。
- `crates/ripple-server/src/skills.rs`：skill manifest rendering。

客户端：

- `app/src/App.tsx`：当前主 App UI。
- `app/src-tauri/`：Tauri desktop/iOS/Android shell。

## 安全

- 不要把 API key、token、cookie、OAuth credential、Codex auth、connector credential 提交到仓库。
- 临时测试文件如果包含敏感信息，测试完毕后删除或明确提示风险。
- 不要把服务端 Codex auth 暴露给 user workspace 或 connector CLI。
- 不要把 per-user connector 凭证写到未忽略路径。
- 测试真实 connector auth 时，优先使用专门测试账号。

## 本地参考项目

- Codex 源码：`/home/lake/workspace/codex`
