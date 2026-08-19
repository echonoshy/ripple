# Task Session API

Task Session 以一个稳定的 `task_id` 承载“确认前对话 + 确认后异步执行”。对外只有一个入口：

```http
POST /v1/task-sessions/responses
```

Google Workspace 场景的请求字段、SSE/callback 输出字段、四种状态和 OAuth 阶段见 [TASK_SESSIONS_GOOGLE_WORKSPACE.md](TASK_SESSIONS_GOOGLE_WORKSPACE.md)。

调用方不需要知道 Ripple 内部 session id，也不需要调用 approval 或 user-input resolve 接口。

## 1. 调用约定

请求需要标准服务鉴权和用户隔离 header：

```http
Authorization: Bearer <API_KEY>
X-Ripple-User-Id: user_001
Accept: text/event-stream
Content-Type: application/json
```

服务始终返回 SSE。确认前的结果在当前 HTTP 连接中返回；确认后的执行状态通过 `callback_url` 异步投递。

### 请求字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `task_id` | 是 | 调用方的稳定任务标识。按 user 隔离；去除首尾空白后不得为空，最大 256 bytes。相同 `task_id` 续接同一任务会话。 |
| `req_id` | 建议 | 本轮请求追踪 ID。服务会原样放入本轮相关的 `task.status`。**不提供幂等性**；重试同一 `req_id` 仍可能再次处理输入。 |
| `input` | 是 | 本轮用户输入。支持 Ripple Responses 当前接受的字符串或 user message 形式；必须能提取出 user message。 |
| `callback_url` | 新任务必填 | 接收确认后状态。后续可省略，但不能更换为其他地址。 |
| `model` | 否 | Ripple 配置中的模型或 Codex runtime 模型 ID。 |
| `reasoning.effort` | 否 | 推理强度，透传给当前 chat 链路。 |
| `instructions`、`metadata`、`store`、`think_level`、`text`、`previous_response_id` | 否 | 与 `/v1/responses` 当前支持的对应字段一致；Task Session 自己决定内部 session，不使用调用方传入的 response/session 续接信息。 |
| `context_folder_path` | 建议每轮传 | 本轮目录 scope，见下一节。 |

除上述字段外，不要依赖 Responses API 的完整字段透传。`stream` 不是 Task Session 请求字段；接口始终建立 SSE。

推荐每轮使用同一请求骨架：

```json
{
  "task_id": "task_001",
  "req_id": "req_001",
  "model": "gpt-5.5",
  "reasoning": { "effort": "high" },
  "input": "帮我明天下午创建一个项目复盘会",
  "callback_url": "https://your-server.example.com/task-status",
  "context_folder_path": "/workspace/projects/review"
}
```

## 2. `context_folder_path` 语义

`context_folder_path` 是请求级目录 scope，不是 Task Session 的持久 session 属性。

| 阶段 | 行为 |
| --- | --- |
| 确认前 | 非空值必须是当前 user workspace 中已存在的 `/workspace/...` 目录；它只影响本轮 Codex cwd、默认文件上下文和 permission root。未传、`null` 或空字符串使用 `/workspace`。 |
| 确认执行的本轮 | 服务将该轮目录锁定给后台 run。 |
| 确认后恢复 | 授权、审批、补充信息请求仍可携带该字段，但它会被忽略；后台 run 始终使用确认时锁定的 cwd 和 permission root。 |

确认前不同目录的连续请求各自独立；服务不会将目录写入内部 `SessionRecord.context_folder_path`，也不会复用前一轮的 Codex thread。

## 3. 状态与投递位置

| `status` | 何时产生 | 投递位置 |
| --- | --- | --- |
| `running` | 模型明确确认并开始执行 | Callback |
| `waiting_user` | 等待 Connector 授权、权限确认或补充信息 | 确认前的 Connector 授权走 SSE；确认后均走 Callback |
| `completed` | 后台任务成功结束 | Callback |
| `failed` | 后台任务失败或取消 | Callback |

确认前的普通澄清、普通提问和确认提示只发送 `response.output_text.delta` 与 `[DONE]`，不会发送 callback。

确认后执行期间，服务还可能通过 Callback 发送临时进度事件。它保持原有字段形状，但 `event` 为 `task.status.tmp`、`status` 固定为 `running`；调用方只展示其 `content`，不得把它当作任务结束或持久状态转换。

`content` 由 Agent 在 task-session 内显式生成：确认执行时 `codex_app.task_execution_confirmed` 必须携带首条用户可见进度；后续每个实质阶段前，Agent 可调用 `codex_app.task_progress` 上报新的进度。服务端只校验并原样转发该文本，不翻译、不添加前后缀，也不会根据工具调用、命令或工具输出生成文案。已有的模型计划更新仍会按原样作为兼容进度转发。文案语言跟随用户的任务语言或用户明确要求的回复语言，调用方必须将它作为任意语言的展示文本处理。

## 4. SSE 协议

### 普通对话

```text
event: response.output_text.delta
data: {"delta":"请补充参会人和会议时间。"}

data: [DONE]
```

### 确认前的 Connector 授权

授权是确认前唯一的结构化 SSE 例外：服务会发送兼容用文本，再发送 `task.status`。调用方必须以 `task.status.required_action` 的结构化字段判断授权阶段和下一步操作；不得解析 `response.output_text.delta` 或 `content` 的文案来判断流程。

```text
event: response.output_text.delta
data: {"delta":"需要完成飞书授权后继续执行。"}

event: task.status
data: {"event":"task.status","task_id":"task_001","req_id":"req_002","status":"waiting_user","content":"需要完成飞书授权后继续执行。","required_action":{"type":"connector_auth","connector":"feishu","stage":"awaiting_user_auth","auth_url":"https://example.com/auth","expires_in_seconds":600}}

data: [DONE]
```

收到 `required_action.type = "connector_auth"` 时，结合 `connector` 和 `stage` 决定本地化展示；需要浏览器操作时，打开**本轮** `auth_url`，完成后以相同 `task_id` 提交下一条输入。存在 `expires_in_seconds` 时，它是上游声明的有效期秒数；调用方可在该 URL 首次收到时据此展示倒计时或提示刷新，重复收到同一 URL 时不得重置倒计时。飞书等 Connector 可能多步授权；若下一轮仍返回 `connector_auth`，必须继续使用最新字段，不能复用旧 URL 或旧 stage。

### SSE 建立后的错误

```text
event: error
data: {"code":"server_error","message":"Agent run failed"}

data: [DONE]
```

## 5. Callback 协议

确认事件被服务端接受并交给后台执行后，当前 HTTP SSE 会立即只返回并关闭：

```text
data: [DONE]
```

服务异步 `POST` 以下 JSON 到任务创建时的 `callback_url`：

```json
{
  "event": "task.status",
  "task_id": "task_001",
  "req_id": "req_004",
  "status": "running",
  "content": "正在核对收件人与邮件内容。"
}
```

执行中的临时进度通知示例：

```json
{
  "event": "task.status.tmp",
  "task_id": "task_001",
  "req_id": "req_004",
  "status": "running",
  "content": "I will verify the source tasks before creating them."
}
```

Agent 也可以生成其他语言的进度文案，例如：
```json
 {
    "event": "task.status.tmp",
    "task_id": "task_001",
    "req_id": "req_004",
    "status": "running",
    "content": "Create Feishu tasks"
  }
```

`content` 是旧客户端可直接展示的兼容文本。新的调用方不得依赖它判断 Connector 授权阶段或拼接本地化文案；应使用下面的 `required_action` 或 `error` 结构化字段。Callback 中的 `waiting_user.required_action` 与 SSE `task.status.required_action` 字段形状相同，包括可选的 `expires_in_seconds`。`waiting_user` 和 `failed` 可额外包含以下字段：

```json
{
  "required_action": {
    "type": "confirm | reply | connector_auth"
  },
  "error": {
    "code": "server_error | cancelled | connector_auth_failed",
    "connector": "feishu",
    "stage": "auth_failed",
    "message": "..."
  }
}
```

当 `error.code = "connector_auth_failed"` 时，`error.connector` 和 `error.stage` 必定存在；调用方可据此展示本地化失败提示，并将 `message` 作为未适配时的 fallback。其他错误类型不包含这两个字段。

`required_action` 的完整形态：

| 类型 | 字段 | 调用方下一步 |
| --- | --- | --- |
| `connector_auth` | `connector`、`stage`、`auth_url`、可选 `expires_in_seconds` | 完成当前授权步骤后，以相同 `task_id` 发送输入。`stage` 是稳定的授权阶段标识，调用方可结合 `connector` 使用本地化文案；有 `expires_in_seconds` 时可按秒显示倒计时或提示刷新。 |
| `confirm` | `approval`（Codex 原始审批信息） | 发送文本批准或拒绝。 |
| `reply` | `message` | 发送补充答案。 |

### Connector 授权阶段

`connector_auth` 的展示由调用方负责。服务端不根据调用方语言翻译，也不要求调用方展示 `content`。当前飞书和 Google Workspace 阶段如下；调用方遇到未知 `stage` 必须保留通用授权入口或错误 fallback，不能假设枚举只有以下值。

| `connector` | `stage` | 结构化数据 | 调用方展示/行为 |
| --- | --- | --- | --- |
| `feishu` | `awaiting_setup` | `auth_url` 指向本轮飞书配置页；`expires_in_seconds` 固定为 `300` | 展示飞书 Bot 配置流程；打开 URL 后等待或提交下一轮输入。`300` 是调用方的刷新/展示建议期限，不会使服务端 setup 在五分钟后失效。 |
| `feishu` | `awaiting_user_auth` | `auth_url` 指向本轮用户 OAuth 页；若 CLI 返回有效期，则携带实际 `expires_in_seconds` | 展示飞书账号授权流程；打开 URL 后等待或提交下一轮输入。有效期来自飞书 device authorization flow；未提供时调用方不应自行猜测。 |
| `feishu` | `pending` | 可能没有新的 `auth_url` | 展示授权处理中/等待确认；不要把空 URL 当作可打开操作。 |
| `feishu` | `authorized` | 不再需要 `connector_auth` action | 展示已授权或继续原任务。 |
| `feishu` | `auth_failed`、`invalid_request` | 以 `error.connector`、`error.stage` 返回 | 展示本地化失败提示；不得返回或伪造 `required_action`。 |
| `google_workspace` | `awaiting_browser_callback` | `auth_url` 指向本轮 Google OAuth 页面；`expires_in_seconds` 固定为 `600` | 打开本轮 URL；授权完成后以相同 `task_id` 提交下一条输入。 |
| `google_workspace` | `authorized` | 不再需要 `connector_auth` action | 服务端恢复原始任务；确认后的任务继续使用已锁定的执行上下文。 |
| `google_workspace` | `auth_failed`、`invalid_request` | 以 `error.connector`、`error.stage` 返回 | 展示本地化失败提示；重新授权必须使用服务端返回的新 URL。 |

审批文本的内置解释：`允许`、`同意`、`确认`、`允许发送`、`继续` 为单次允许；`始终允许` 为本 Task Session 持续允许；`拒绝`、`不同意`、`取消`、`不要发送` 为拒绝。

Callback 以后台任务异步发送。任意 HTTP 2xx 都表示接收成功，响应体不解析；失败时立即再尝试一次，第二次失败只记日志。不同状态的 callback 是独立异步请求，调用方应按 `task_id` 和状态处理，不能把网络到达顺序当作唯一顺序依据。

## 6. 生命周期

1. 首轮带 `task_id`、`callback_url`、`input` 和 `context_folder_path` 发起对话。
2. 信息不足时，读取 SSE 文本并用同一 `task_id` 补充输入。
3. 确认前遇到 Connector 授权时，处理 SSE `task.status.required_action`，完成授权后继续对话。
4. 用户明确确认后，SSE 返回 `[DONE]`；等待 Callback `running` 与最终状态。
5. 运行中收到 `waiting_user` callback 时，仅继续调用本接口：
   - `connector_auth`：完成授权后提交任意继续输入；
   - `confirm`：提交允许、始终允许或拒绝文本；
   - `reply`：提交补充信息。
6. 接收 `completed` 或 `failed` callback 后结束任务。

## 7. HTTP 错误

SSE 建立前的输入或状态错误使用标准 Ripple 错误 envelope：

```json
{
  "detail": "callback_url is required for a new task session",
  "error": {
    "code": "bad_request",
    "message": "callback_url is required for a new task session"
  }
}
```

常见情况：

| HTTP 状态 | 原因 |
| --- | --- |
| `400` | 缺少/空 `task_id`、缺少 user input、新 task 缺少 `callback_url`、确认前目录不存在或越出 workspace。 |
| `409` | 尝试为已有 task 更换 `callback_url`，或内部 session 已有无法恢复的进行中工作。 |
| `401` | API key 无效或缺失。 |

## 8. 调用方注意事项

- `task_id` 是续接键，`req_id` 只是追踪键；请在调用方自行实现网络重试幂等性。
- 不要调用内部 Session approval、Session user-input resolve、TaskSpec 或 TaskRun 接口。
- 不要把一次 Connector 授权视为完成；以最新 `required_action` 为准。
- `callback_url` 应为调用方可稳定接收服务端回调的地址；首次绑定后不可变更。
