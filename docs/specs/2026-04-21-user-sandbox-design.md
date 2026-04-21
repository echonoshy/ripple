# User 层沙箱重构设计方案

- 日期：2026-04-21
- 状态：草案待评审

## 1. 背景与动机

当前架构下，沙箱（workspace + 凭证 + nsjail.cfg）以 session 为隔离单位，位于
`.ripple/sessions/<session_id>/` 下。这导致：

- 每开一个新 session，`.venv` / `.local` / `.lark-cli` 都要重建，体验沉重。
- 用户自己装的 skills、历史工作文件无法在不同对话间沿用，只能手动挂起/恢复老 session。
- 飞书/Notion 凭证本质上是"属于这个人"的，却被绑到 session 级，每次新开对话都得重填。
- N 个 session = N 份 `.venv` 目录骨架，碎片化严重。

根本原因是：**"沙箱" 的正确粒度是 "人"，不是 "这次对话"**。本次改造把沙箱从 session 级上提到 user 级，session 只保留对话态（meta / messages / tasks / task-outputs）。

## 2. 设计原则

- **user_id 是分区 key，不是身份**。ripple 不做认证、不存 user profile，user_id 由上游业务服务端保证合法、直接传入。
- **sandbox 是顶层概念**。ripple 对外暴露的是"给某个 user_id 提供/销毁沙箱"的能力，而不是"用户管理"。
- **API key 白名单维持现状**，仍是服务级准入，与 user 层正交。
- **一个 user 一个沙箱，沙箱长期存在**，session 轻量。
- **YAGNI**：不做登录、不做密码、不做 quota 多租户策略。能运行起来、凭证/workspace 隔离正确，就够了。

## 3. 目标架构

### 3.1 核心概念

| 概念 | 生命周期 | 存储位置 | 谁创建 | 谁销毁 |
|---|---|---|---|---|
| Sandbox | 长期 | `.ripple/sandboxes/<user_id>/` | 显式 API 或首次使用懒创建 | 显式 DELETE API |
| Session | 一次对话 | `.ripple/sandboxes/<user_id>/sessions/<sid>/` | chat_completions / 显式创建 | TTL / 显式删除 |
| 全局缓存 | 全局 | `.ripple/sandboxes-cache/` | 首次使用 | 不清理 |

Sandbox 与 user_id **一一对应**，user_id 是它的唯一 key。

### 3.2 目录布局

```
.ripple/
├── logs/ripple.log
├── sandboxes-cache/                   # 全局共享，不变
│   ├── uv-cache/
│   ├── corepack-cache/
│   └── pnpm-store/
└── sandboxes/
    └── <user_id>/                     # 一个 user 一个沙箱
        ├── credentials/
        │   ├── feishu.json            # 从 session 级上提到这里
        │   └── notion.json            # 同上
        ├── workspace/                 # 跨 session 持久的 /workspace
        │   ├── .venv/ .local/ .lark-cli/ skills/
        │   └── <用户文件>
        ├── nsjail.cfg                 # per-user 一份，mount src 指向 workspace
        └── sessions/
            └── <session_id>/
                ├── meta.json
                ├── messages.jsonl
                ├── tasks.json
                └── task-outputs/
```

### 3.3 user_id 合法性约束

user_id 直接用于拼路径，必须严格校验以防路径穿越：

- 正则：`^[a-zA-Z0-9_-]{1,64}$`（和现有 `_validate_session_id` 同款）
- 缺省值：请求缺失 `X-Ripple-User-Id` header 时，使用 `default`
- 保留：`default` 是系统保留 id，允许使用但不可删除（DELETE 返回 409）

## 4. 数据模型

### 4.1 Sandbox（磁盘态）

没有 `profile.json`。sandbox 的"存在"由目录本身定义：

```python
def sandbox_exists(config, user_id) -> bool:
    return config.sandbox_dir(user_id).exists()
```

sandbox 的元信息（创建时间、大小等）按需从文件系统推导，不单独存一份。**这一点有意为之**——避免多来源真相。

### 4.2 Session（无变化，只是搬家）

`meta.json` / `messages.jsonl` / `tasks.json` / `task-outputs/` 字段和格式**完全不变**，只是路径从 `.ripple/sessions/<sid>/` 挪到 `.ripple/sandboxes/<uid>/sessions/<sid>/`。这样可以最大限度复用现有 `storage.py`。

## 5. API 合同

### 5.1 user_id 传递

- 传递方式：HTTP header `X-Ripple-User-Id: <user_id>`
- 所有受影响端点统一从 header 取，通过 FastAPI `Depends` 注入到业务层
- 缺失时回落到 `default`，**不抛 400**（对旧客户端兼容）
- 非法字符抛 `400 Invalid user_id`

```python
# interfaces/server/deps.py (新增)
async def get_user_id(x_ripple_user_id: str | None = Header(None, alias="X-Ripple-User-Id")) -> str:
    uid = (x_ripple_user_id or "default").strip()
    if not _USER_ID_RE.match(uid):
        raise HTTPException(400, f"Invalid X-Ripple-User-Id: {uid!r}")
    return uid
```

### 5.2 Sandbox 管理端点（新增）

| Method | Path | 行为 |
|---|---|---|
| `POST` | `/v1/sandboxes` | 为当前 header 中的 user_id 创建沙箱；已存在则幂等返回 |
| `GET` | `/v1/sandboxes` | 返回当前 user 沙箱的摘要（workspace 大小、session 数、创建时间） |
| `DELETE` | `/v1/sandboxes` | 销毁当前 user 沙箱（含全部 session 和 workspace）；`default` 返回 409 |

为什么不是 `/v1/sandboxes/{user_id}`？—— user_id 从 header 取，URL 保持与"身份"无关，便于未来替换为 token。

### 5.3 Session API 变更

URL 形态**保持不变**（`/v1/sessions`、`/v1/sessions/{sid}` 等），但：

- 所有端点依赖 `get_user_id`，内部从 `(user_id, session_id)` 二元组定位 session
- session_id 在单个 user 内唯一即可（不要求全局唯一）
- `list_sessions` 只返回当前 user 名下的 session
- 访问不属于当前 user 的 session_id → `404 Session not found`

### 5.4 Sandbox 懒创建策略

调用 `chat_completions` 等 session 相关 API 时，如果 user 的 sandbox 不存在，**自动创建**。这样：

- 上游业务可以选择"用户首次接入时先调 POST /v1/sandboxes 预热"，也可以直接开聊
- 不会因为忘了 provision 而莫名其妙报错

但 `GET /v1/sandboxes` 在沙箱不存在时返回 404（不触发懒创建），用来让调用方探测状态。

## 6. SandboxConfig 改造

### 6.1 路径方法签名

当前：`session_dir(sid)`、`workspace_dir(sid)`、`feishu_config_file(sid)` ……

改成：

```python
class SandboxConfig:
    sandboxes_root: Path               # 新，默认 .ripple/sandboxes
    caches_root: Path                  # 保留

    def sandbox_dir(self, user_id: str) -> Path: ...
    def workspace_dir(self, user_id: str) -> Path: ...
    def nsjail_cfg_file(self, user_id: str) -> Path: ...
    def feishu_config_file(self, user_id: str) -> Path: ...
    def notion_config_file(self, user_id: str) -> Path: ...

    def session_dir(self, user_id: str, session_id: str) -> Path: ...
    def meta_file(self, user_id: str, session_id: str) -> Path: ...
    def messages_file(self, user_id: str, session_id: str) -> Path: ...
    def tasks_file(self, user_id: str, session_id: str) -> Path: ...
    def task_outputs_dir(self, user_id: str, session_id: str) -> Path: ...
```

所有原先接受 `session_id` 的方法，按其本质归属重新签名：**workspace 层 → 只要 user_id；对话层 → 要 (user_id, session_id)**。

### 6.2 删除的方法

- `has_python_venv(session_id)` → `has_python_venv(user_id)`
- `has_pnpm_setup(session_id)` → `has_pnpm_setup(user_id)`
- `has_lark_cli_config(session_id)` → `has_lark_cli_config(user_id)`
- `has_notion_token(session_id)` → `has_notion_token(user_id)`

### 6.3 配置文件（`config/settings.yaml`）

新增可选字段：

```yaml
server:
  sandbox:
    sandboxes_root: ".ripple/sandboxes"   # 默认
    default_user_id: "default"            # 缺失 header 时的回落值
```

## 7. 凭证与 per-user 工具改造

### 7.1 NotionTokenSetTool（`tools/builtin/notion_token_set.py`）

当前它直接读 `context.sandbox_session_id` 写到 `notion_config_file(sid)`。要改成：**从 context 取 user_id，写到 `notion_config_file(user_id)`**。

这意味着 `ToolUseContext` 需要加 `user_id` 字段（见下一节）。

### 7.2 FeishuConfig 注入

`POST /v1/sessions` 允许传 `feishu: FeishuConfig`，当前写到 session 级。改造后：

- 写入路径变成 user 级 `credentials/feishu.json`
- 语义变成"为这个 user 设置/覆盖 feishu 凭证"
- `POST /v1/sessions` 的 `feishu` 字段保留，但作用从 session 级注入改为 user 级 upsert（下次调用会被覆盖）
- **本期不新增独立的 `PUT /v1/sandboxes/credentials/*` 端点**，等前端真需要"只改凭证不开会话"时再加

### 7.3 lark-cli OAuth 流程

`sandbox/feishu.py` 里的 `ensure_lark_cli_config` 和 `_feishu_setup_states` 字典当前都按 session_id 索引。改造后：

- 以 user_id 为 key（因为 `/workspace/.lark-cli/config.json` 现在是 user 共享的）
- 同一 user 并发触发配置时，复用已有的 URL（字典 + 锁已有基础，只改 key 名）

## 8. 并发控制

### 8.1 问题

workspace 跨 session 共享后，同一 user 的多个 session 可能并发：

- 同时 `pnpm add` → 损坏 `node_modules` / pnpm 锁
- 同时写 `/workspace/data.csv` → 内容交错
- 同时触发 `.venv` 初始化 → 半成品 venv

### 8.2 方案：user 级 tool-call 锁

在 `SandboxManager`（或新的 `SandboxRuntime`）内维护 `dict[user_id, asyncio.Lock]`。沙箱执行器 `executor.run_in_sandbox()` 进入时 `async with lock`，退出时释放。

粒度说明：

- **锁的是"一次沙箱命令执行"**，不是整个 session 的生命周期
- 两个 session 可以同时处于 running 状态，但真正触发 Bash/Write 时会排队
- `Read` 工具读宿主 workspace 文件，不进沙箱，**不受此锁约束**（纯读不需要互斥）

### 8.3 锁不保护的场景（有意为之）

- 外部进程直接操作 workspace（不走 ripple）
- 不同 user 之间的工具调用（天然互不干扰）
- Python venv / pnpm 初始化等 provisioning 阶段（已有独立锁，保持原样）

## 9. ToolUseContext 字段变更

```python
@dataclass
class ToolUseContext:
    # 已有
    session_id: str
    workspace_root: Path | None
    sandbox_session_id: str | None        # 保留但语义变化，见下
    session_runtime_dir: Path | None      # 保留

    # 新增
    user_id: str | None = None            # 沙箱 user_id
```

语义调整：

- `workspace_root` 现在指向 `sandboxes/<uid>/workspace`
- `sandbox_session_id` 字段保留（为了向后兼容工具代码），但**其语义变为 "宿主识别 id，用于日志/遥测"**。真正决定沙箱路径的是 `user_id`。
- `session_runtime_dir` 指向 `sandboxes/<uid>/sessions/<sid>/`
- `is_sandboxed` 校验改为：`workspace_root` 是否在 `sandboxes_root` 下

## 10. 实现顺序（增量路线）

依赖关系：user_id 先要能从 HTTP 传进来 → 再进 SandboxManager → 再进工具。按依赖顺序：

1. **第 1 步：路径层改造（底层）**
   - 新增 `SandboxConfig.sandbox_dir / workspace_dir(uid) / session_dir(uid, sid)` 等方法
   - 新增 `_USER_ID_RE` 校验 + `SANDBOXES_DIR` 路径常量
   - 本步不删旧签名，共存
   - test：纯路径拼接 + 校验函数单测
2. **第 2 步：SandboxManager 加 user 维度**
   - `ensure_sandbox(uid)` / `teardown_sandbox(uid)` / `setup_session(uid, sid)` / `teardown_session(uid, sid)` / `suspend/resume_session(uid, sid)`
   - per-user `asyncio.Lock` 字典
   - test：并发两个 session 跑 Bash，验证锁顺序、验证 workspace 隔离
3. **第 3 步：Server 注入 user_id + ToolUseContext 加 user_id**
   - 新增 `interfaces/server/deps.py::get_user_id`
   - `SessionManager._sessions` 改为 `dict[tuple[uid, sid], Session]`
   - 所有 route 加 `user_id: str = Depends(get_user_id)`
   - `_create_session_context` 把 user_id 塞进 `ToolUseContext`
   - test：不同 header 访问到不同 session 列表、跨 user 访问 session 返回 404
4. **第 4 步：凭证 / per-user 工具改造**
   - `feishu_config_file(uid)` / `notion_config_file(uid)` 切换（此时 context.user_id 已可用）
   - `NotionTokenSetTool` 改从 `context.user_id` 取
   - `sandbox/feishu.py` 的 `_feishu_setup_states` / `_lark_cli_config_locks` 改 key 为 user_id
   - `sandbox/notion.py::read_notion_token` 按 user_id 读
   - test：同一 user 写 token 后换 session 能读到；不同 user 互不可见
5. **第 5 步：Sandbox 管理端点**
   - `POST/GET/DELETE /v1/sandboxes`
   - chat_completions 里的懒创建
   - test：create → chat → delete → 再 chat 触发懒创建
6. **第 6 步：清理**
   - 删除 `.ripple/sessions/`（按 C1 决策）
   - 移除 SandboxConfig 中未使用的旧签名
   - 前端 API 调用统一带 `X-Ripple-User-Id` header

每步都能独立 commit、独立 rollback。前端只有第 6 步需要同步改动。

## 11. 迁移与废弃

- **旧数据**：直接删 `.ripple/sessions/`（按决策 C1）
- **旧配置键**：`server.sandbox.sessions_root` → `server.sandbox.sandboxes_root`。保留旧键一个版本，读到时打 warning 并自动映射
- **前端**：`src/interfaces/web` 在所有 API 调用处加 `X-Ripple-User-Id` header（初期可硬编码 `default`，后续由上游注入）

## 12. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| workspace 跨 session 共享引入写冲突 | 数据损坏 | user 级工具调用锁（§8） |
| user_id 路径穿越 | RCE 级 | `_USER_ID_RE` 严格正则 + `Path.resolve().relative_to(sandboxes_root)` 双重校验 |
| user workspace 增长无上限 | 磁盘爆 | 保留 `max_workspace_mb` 配额（2048 可能偏小，需要在实测后调） |
| DELETE 沙箱期间用户仍在发请求 | 半删除状态 | 删除操作独占 user 锁，先 cancel 所有活动 session 再 rmtree |
| 默认 user `default` 被滥用为"所有人的共享沙箱" | 数据混淆 | 文档明示：`default` 仅用于开发和本地单机；生产上游应强制传 user_id |
| 已挂起的 session 恢复时发现 sandbox 被删了 | 恢复失败 | resume 时先 `ensure_sandbox(uid)`，缺 workspace 就重建（跟现在 `resume_session` 语义一致） |

## 13. 开放问题

下面这些我不打算在本 spec 里拍死，实现时再看：

- **Sandbox 配额**：2GB 是否需要从 per-session 提到 per-user 时同步放大？先沿用默认，实测再调。
- **Sandbox 摘要**：`GET /v1/sandboxes` 里要不要返回 venv/pnpm/lark-cli 的就绪状态？倾向于给，方便前端展示。
- **Session 搬家**：未来是否要支持"把 session A 从 user X 移到 user Y"？暂不支持。
- **Sandbox 统计端点**：`GET /v1/sandboxes/usage` 返回所有 user 的沙箱大小用于运维？暂不做，上游自己统计。

## 14. 不做的事（YAGNI 清单）

- 不做 user 身份鉴权、密码、登录
- 不做 profile.json 或 user 元信息表
- 不做 user_id 的 CRUD
- 不做 per-user 模型配额、token 限额
- 不做 sandbox 跨机器迁移、快照、备份
- 不做 session → user 的权限体系（current user 默认对其所有 session 有全部权限）
