# SQLite 控制面存储方案

## Summary

- SQLite 只存控制面元数据、状态、索引和关联关系；不存大文件内容。
- 用户上传文件、workspace 文件、附件内容、run output artifact 继续存文件系统，后期可迁 OSS。
- SQL 表中只保存文件路径、storage URI、mime、size、hash、归属关系等 metadata。
- 使用 sqlx + SQLite，所有 DB 读写对业务层暴露 async API，为后续 PostgreSQL 迁移做准备。
- 现有 /v1 API response shape 保持不变。

## Storage Boundary

进入 SQLite：

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
- Codex 运行目录文件
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

## Key Implementation Changes

- 新增 storage 层：
  - Storage 初始化 SQLite pool 和 migrations。
  - SessionStore 管 session 和 messages。
  - JobStore 管 runs/jobs metadata。
  - ScheduleStore 管 schedules。
  - DocumentStore 管 document index。
- 使用 sqlx：
  - 第一阶段使用 SQLite pool。
  - SQL 避免 SQLite 专有能力，JSON 先用 TEXT 存储。
  - 后期可切换 PostgreSQL backend。
- 推荐数据库位置：
  - .ripple/ripple.sqlite
  - 表内统一带 user_id。
- 写入策略：
  - session message append + session meta update 使用事务。
  - run status 更新使用短事务。
  - schedule trigger/update 使用事务避免并发状态覆盖。
- 文件系统保留职责：
  - workspace/ 仍是用户文件工作区。
  - upload/download 仍走 tokio::fs。
  - connector credentials 继续写 credentials/，保证 CLI 兼容。
  - run events/output 暂时继续文件落盘，避免影响 SSE 和 artifact 读取。

## Migration Strategy

- 不做服务启动自动迁移。
- 提供显式一次性迁移命令，例如：

```bash
ripple-server migrate-files-to-sqlite --config config/settings.yaml
```

- 迁移来源：
  - user.json
  - sessions/<session_id>/meta.json
  - sessions/<session_id>/messages.jsonl
  - agent-runs/external-agents/*/meta.json
  - sessions/<session_id>/external-agents/*/meta.json
  - schedules/schedules.json
  - documents/index.json
- 迁移要求：
  - 幂等 upsert。
  - 不删除旧文件。
  - 输出导入数量、跳过数量、错误路径。
  - 迁移完成后服务以 SQLite 为控制面权威数据源。

## Schema Direction

核心表：

```text
users
sessions
session_messages
jobs
schedules
documents
file_refs
```

关键索引：

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

SQLite 配置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

## Test Plan

- Storage tests:
  - migrations 初始化成功。
  - sessions/messages CRUD。
  - jobs status 更新和 list 查询。
  - schedules CRUD 和 due trigger 查询。
  - documents/file refs CRUD。
  - chat 写入后 session messages 可恢复。
  - /v1/runs history 正常。
  - schedule CRUD/run-now 正常。
  - documents list/search 正常。
  - 内部资源限制统计正常。
- Migration tests:
  - 构造旧文件树，迁移后 API 能读到旧数据。
  - 重复执行迁移不重复插入。
- Boundary tests:
  - 上传文件内容不进入 SQLite。
  - workspace 文件读写仍走文件系统。
  - connector credentials 仍按现有文件路径工作。
  - run events/output 仍能正常 SSE 和读取。

## Assumptions

- SQLite 目标是提升查询、管理、分页、统计能力，不是替代文件/对象存储。
- 对话记录适合入 SQLite，但大附件只存引用。
- 第一阶段不迁 run events/output 全量内容。
- 后期 PostgreSQL 是明确方向，因此优先选择 sqlx 而不是 rusqlite。
