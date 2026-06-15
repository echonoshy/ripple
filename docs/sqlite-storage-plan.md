# SQLite Control Plane Storage

SQLite 是 `ripple-server` 当前控制面状态存储。它不替代用户 workspace、附件二进制或 connector 凭证文件；这些仍然保存在文件系统里，SQLite 只保存可查询的控制面数据和引用。

## Storage Boundary

进入 SQLite：

- users、auth invites、auth sessions
- sessions
- session messages
- runs/jobs metadata
- schedules
- documents index
- pending approval / pending question / pending connector auth 状态
- plan steps / progress
- 文件索引 metadata：路径、大小、mime、hash、关联 session/document

不进入 SQLite：

- workspace 文件内容
- 用户上传文件内容
- 图片、PDF、附件二进制
- Codex runtime 目录文件
- connector credential 文件
- run events.jsonl
- run output.txt

文件相关 SQL 只保存引用，例如：

```text
file_id
user_id
storage_backend   -- local now, oss later
storage_uri       -- /workspace/uploads/a.pdf now, oss://bucket/key later
workspace_path
mime_type
size_bytes
sha256
created_at
linked_session_id
```

## Runtime Model

- 默认数据库位置是 `.ripple/ripple.sqlite`。
- SQLite 使用 WAL，运行时会同时出现 `.ripple/ripple.sqlite-wal` 和 `.ripple/ripple.sqlite-shm`。
- 表内统一带 `user_id`，查询和写入都必须保持 user scope。
- `Storage::open` 负责初始化表结构、补齐必要 schema column，并记录 `schema_migrations`。
- session message append + session meta update、run status 更新、schedule trigger/update 这类状态变化应保持短事务。
- `/v1` response shape 不因 SQLite 存储改变而破坏旧客户端。

## Filesystem Responsibilities

文件系统仍负责：

- `.ripple/sandboxes/<user_id>/workspace` 或 `sandbox.workspaces_root/<user_id>/workspace`
- `.ripple/sandboxes/<user_id>/credentials`
- app-server/Codex runtime home
- connector CLI 配置和 cookie/keyring
- run events/output artifact

这条边界很重要：SQLite 是控制面索引和状态，不是大文件或用户工作区的存储后端。

## Legacy File Migration

旧文件状态不会在服务启动时自动迁移。需要时显式运行一次性命令：

```bash
ripple-server migrate-files-to-sqlite --config config/settings.yaml
```

迁移来源包括：

- user.json
- sessions/<session_id>/meta.json
- sessions/<session_id>/messages.jsonl
- agent-runs/external-agents/*/meta.json
- sessions/<session_id>/external-agents/*/meta.json
- schedules/schedules.json
- documents/index.json

迁移要求：

- 幂等 upsert。
- 不删除旧文件。
- 输出导入数量、跳过数量、错误路径。
- 迁移完成后服务以 SQLite 为控制面权威数据源。

## Schema Direction

核心表：

```text
users
auth_invites
auth_sessions
sessions
session_messages
jobs
schedules
documents
file_refs
schema_migrations
```

关键索引方向：

```text
sessions(user_id, last_active)
sessions(user_id, status)
session_messages(user_id, session_id, seq)
jobs(user_id, updated_at)
jobs(user_id, session_id)
jobs(user_id, status)
schedules(user_id, status, next_run_at)
documents(user_id, updated_at)
file_refs(user_id, workspace_path)
```

SQLite 配置方向：

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

## Verification

存储相关改动至少运行：

```bash
cargo test -p ripple-server storage
cargo test -p ripple-server migration
cargo check -p ripple-server
```

涉及 API response、session/job/schedule 行为时，再补充对应 route tests 或：

```bash
bash scripts/smoke-rust-server.sh
```
