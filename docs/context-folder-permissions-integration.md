# Context Folder Permissions Integration

本文给产品层、Web/Tauri/Mobile 客户端和上游业务系统说明如何对接 Ripple 的 workspace / space / record 三层对话入口，以及目录级最小权限审批。

## 结论

- 三层入口都先创建或复用一个 Ripple session。
- session 的 `context_folder_path` 就是本次 Codex 的 cwd 和 permission root。
- `context_folder_path: null` 表示整个 `/workspace`。
- space 对话传 `/workspace/spaces/<space_id>`。
- record 对话传 `/workspace/spaces/<space_id>/records/<record_id>`。
- 该目录必须已经存在，并且必须在当前 user workspace 内。
- scoped session 下，Codex 默认只能读写 `context_folder_path`；访问同一 workspace 下其他目录会触发 `permissions` approval。
- 直接调用 `/v1/responses` 自动创建 session 时，目前不能同时设置 `context_folder_path`。三层入口必须先 `POST /v1/sessions`，再把 session id 放进 `/v1/responses.metadata.ripple_session_id`。

## 认证 Header

所有受保护接口统一带：

```http
Authorization: Bearer <server_api_key>
X-Ripple-User-Id: <user_id>
Content-Type: application/json
```

`X-Ripple-User-Id` 是 user workspace 隔离入口，合法字符为 `[a-zA-Z0-9_-]{1,64}`。生产环境应由可信上游注入，浏览器不要自行伪造。

下面示例统一使用：

```bash
BASE_URL="http://127.0.0.1:8810/v1"
API_KEY="..."
USER_ID="u_123"
```

## 目录模型

推荐 workspace 结构：

```text
/workspace/
├── AGENTS.md
├── spaces/
│   └── <space_id>/
│       ├── AGENTS.md
│       └── records/
│           └── <record_id>/
│               ├── AGENTS.md
│               ├── original.md
│               ├── summary.md
│               ├── title.md
│               └── mindmap.md
└── .tmp/
```

约定：

- `/workspace`：用户长期 workspace。
- `/workspace/spaces/<space_id>`：space 入口。
- `/workspace/spaces/<space_id>/records/<record_id>`：record 入口。
- `AGENTS.md` 是规则/上下文来源，不是安全边界；安全边界由 permission profile 执行。
- 从 `/workspace` 到当前 `context_folder_path` 的祖先 `AGENTS.md` 会被授予 read，以便 Codex 读取规则。

## 目录初始化

`context_folder_path` 必须指向已存在目录。目录通常由产品层创建。

如果产品层只走 Ripple workspace API，可以通过写一个占位文件或 `AGENTS.md` 来创建父目录。`PUT /v1/workspace/file` 会自动创建父目录。

```bash
curl -X PUT "$BASE_URL/workspace/file" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/workspace/spaces/space_a/AGENTS.md",
    "content": "# Space Rules\n\n- 本目录保存一个 space 下的长期上下文。\n"
  }'

curl -X PUT "$BASE_URL/workspace/file" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/workspace/spaces/space_a/records/record_001/AGENTS.md",
    "content": "# Record Rules\n\n- 本目录保存单条记录的原文、摘要、标题和脑图。\n"
  }'
```

只要目录存在即可，不要求一定有 `AGENTS.md`。但建议每一层有清晰规则，避免把上下文全塞进 prompt。

## 创建三层 Session

### Workspace 入口

```bash
curl -X POST "$BASE_URL/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-medium",
    "context_folder_path": null
  }'
```

也可以传 `"/workspace"`，服务端会等价规范化为 `null`。

### Space 入口

```bash
curl -X POST "$BASE_URL/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-medium",
    "context_folder_path": "/workspace/spaces/space_a"
  }'
```

### Record 入口

```bash
curl -X POST "$BASE_URL/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-medium",
    "context_folder_path": "/workspace/spaces/space_a/records/record_001"
  }'
```

响应会包含：

```json
{
  "session_id": "sess_xxx",
  "status": "idle",
  "context_folder_path": "/workspace/spaces/space_a/records/record_001",
  "pending_approval_count": 0
}
```

客户端需要保存 `session_id`，后续 chat 用它续接。

## 发送 Chat

推荐使用 `/v1/responses`，并显式传入 session id：

```bash
SESSION_ID="sess_xxx"

curl -N -X POST "$BASE_URL/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-medium",
    "stream": true,
    "previous_response_id": "resp_sess_xxx",
    "metadata": {
      "ripple_session_id": "sess_xxx",
      "req_id": "client-request-001"
    },
    "input": [
      {
        "role": "user",
        "content": "请基于这条记录生成摘要和标题。"
      }
    ]
  }'
```

规则：

- `metadata.ripple_session_id` 是最明确的续接方式。
- `previous_response_id` 用 `resp_<session_id>`，用于兼容 Responses-style 客户端。
- 两者都传时应指向同一个 session。
- 不要在 `/v1/responses` 里临时传目录；目录绑定在 session 上。

## SSE 事件处理

流式响应里普通文本使用 Responses-style 事件：

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"..."}
```

Ripple 控制面事件会以 `ripple.*` 事件名发出，并带 `ripple_event_type`：

```text
event: ripple.approval_required
data: {
  "type": "ripple.approval_required",
  "ripple_event_type": "approval_required",
  "approval": {
    "job_id": "agent-xxxx",
    "session_id": "sess_xxx",
    "request_id": "...",
    "action": "permissions",
    "metadata": {
      "reason": "Need to read a sibling record",
      "cwd": "/workspace/spaces/space_a/records/record_001",
      "permissions": {
        "file_system": {
          "entries": [
            {
              "path": "/workspace/spaces/space_a/records/record_002",
              "mode": "read"
            }
          ]
        }
      }
    }
  }
}
```

客户端处理建议：

- 如果 `type` 以 `ripple.` 开头，优先读取 `ripple_event_type` 作为业务事件类型。
- 当 `ripple_event_type === "approval_required"` 且 `approval.action === "permissions"`，展示目录权限审批卡。
- 审批卡展示 `metadata.reason`、`metadata.cwd` 和 `metadata.permissions` 中的 read/write 路径。
- 其他 approval 类型保留 JSON fallback，不要丢失原始信息。

## 处理权限审批

用户可以选择：

| UI 操作 | API action | Codex scope |
| --- | --- | --- |
| 允许一次 | `allow` | `turn` |
| 本会话允许 | `always` | `session` |
| 拒绝 | `deny` | 空 permissions |

调用：

```bash
curl -X POST "$BASE_URL/sessions/$SESSION_ID/permissions/resolve" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "allow"
  }'
```

响应：

```json
{
  "ok": true,
  "session_id": "sess_xxx",
  "job_id": "agent-xxxx",
  "action": "allow"
}
```

resolve 后不要重发原用户请求。后端会把审批结果交回原 Codex turn，并在后台继续运行。

由于触发审批时原 SSE 响应已经结束，客户端应在 resolve 后：

1. 轮询 `GET /v1/sessions/<session_id>`，直到 `status` 不再是 `running` / `awaiting_permission`。
2. 用返回的 `messages` / `pending_permission_request` 刷新 UI。
3. 如果又出现新的 `pending_permission_request`，继续展示审批卡。

## 更新 Session 的 Context Folder

切换目录：

```bash
curl -X PATCH "$BASE_URL/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "context_folder_path": "/workspace/spaces/space_b"
  }'
```

重置为 workspace 根：

```bash
curl -X PATCH "$BASE_URL/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "context_folder_path": null
  }'
```

限制：

- 目标目录必须存在。
- active run、context compaction、pending permission approval 期间返回 `409`。
- 更新只影响后续 turn；已经在跑的 turn 不会中途换权限根。

## 独立 Run API

如果外部调度器直接走 `/v1/runs`，`cwd` 同样是该 run 的 permission root：

```bash
curl -X POST "$BASE_URL/runs" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "codex",
    "prompt": "检查这条记录并补齐 summary.md",
    "cwd": "/workspace/spaces/space_a/records/record_001"
  }'
```

`cwd` 未传时默认为 `/workspace`。传入 `/workspace/...` 时必须在当前 user workspace 内。

## 错误码与处理

常见错误：

| 状态码 | 场景 | 处理 |
| --- | --- | --- |
| `400` | `context_folder_path` 非法、越界、不是目录，或请求缺少 user message | 修正路径/请求体 |
| `401` | API key 或 user auth 无效 | 重新认证 |
| `404` | session、run 或 workspace 不存在 | 刷新状态或重新创建 |
| `409` | session 正在运行、正在等待审批，或没有待处理审批 | 刷新 session 状态后重试 |
| `428` | 高风险 workspace/connector API 缺少 `confirm: true` | 让用户确认后重试 |

## 前端接入清单

1. 根据入口类型计算 `context_folder_path`。
2. 确保该目录存在；必要时写入 `AGENTS.md` 或 `.keep` 初始化目录。
3. `POST /v1/sessions` 创建 session，并保存 `session_id`。
4. `POST /v1/responses` 发送消息，带 `metadata.ripple_session_id`。
5. SSE 中处理 `ripple.approval_required`。
6. 对 `approval.action === "permissions"` 渲染结构化权限卡。
7. 用户选择后调用 `/sessions/<id>/permissions/resolve`。
8. resolve 后轮询 session 详情，直到原 run 完成或再次等待审批。
9. 切换 space/record 前，先确认 session 不在 running/awaiting 状态，再 `PATCH /v1/sessions/<id>`。

## 不要这样接

- 不要把目录路径只放进 prompt；必须绑定到 `context_folder_path`。
- 不要依赖 Codex 自己“自觉”不访问其他目录；安全边界是 permission profile。
- 不要用 `/v1/responses` 自动创建三层 session；它无法设置 `context_folder_path`。
- 不要在等待审批时切换 context folder。
- 不要把跨 session 永久授权存在客户端；第一版只有 turn/session scope。
