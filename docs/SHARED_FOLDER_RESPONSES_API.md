# Shared Folder Responses API

## Request

```http
POST /v1/shared-folders/responses
Authorization: Bearer <api-key>
X-Ripple-User-Id: <user_id>
Content-Type: application/json
```

```json
{
  "req_id": "req_001",
  "session_id": "session_001",
  "shared_folder": "a-folder",
  "input": "请总结这个共享目录中的文件",
  "model": "gpt-5.5",
  "reasoning": {
    "effort": "medium"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `req_id` | string | 是 | 请求标识，用于日志和问题定位；不参与幂等控制 |
| `session_id` | string | 是 | 会话标识，用于保持上下文；同一 session 固定绑定一个共享目录 |
| `shared_folder` | string | 是 | 共享目录名称，例如 `a-folder`；只允许一级目录标识 |
| `input` | string / Responses input | 是 | 本轮用户输入，格式与 Responses API 的 `input` 接近 |
| `model` | string | 否 | 指定模型；未传时使用服务端默认模型 |
| `reasoning` | object | 否 | 推理配置 |
| `reasoning.effort` | string | 否 | 推理等级，例如 `low`、`medium`、`high` |


字段约束：

- `session_id`：`^[a-zA-Z0-9_-]{1,64}$`
- `shared_folder`：`^[a-zA-Z0-9_-]{1,64}$`
- `req_id`：1～256 个可打印字符
- 同一个 `session_id` 后续请求必须继续使用首次绑定的 `shared_folder`
- 需要切换共享目录时，调用方必须创建新的 `session_id`

## Response

响应头：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-Ripple-Req-Id: req_001
X-Ripple-Session-Id: session_001
Cache-Control: no-cache
```

### Response Created

```text
event: response.created
data: {"type":"response.created","response":{"id":"resp_session_001","object":"response","created_at":1786347338,"status":"in_progress","model":"gpt-5.5","metadata":{"req_id":"req_001","session_id":"session_001","ripple_session_id":"session_001","shared_folder":"a-folder"}}}
```

### Text Delta

回答内容通过多个增量事件返回：

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","response_id":"resp_session_001","item_id":"msg_001","output_index":0,"content_index":0,"delta":"共享目录"}
```

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","response_id":"resp_session_001","item_id":"msg_001","output_index":0,"content_index":0,"delta":"中共有 3 个文件。"}
```

客户端按照事件顺序拼接 `delta` 即可得到完整文本。

### Response Completed

```text
event: response.completed
data: {"type":"response.completed","response":{"id":"resp_session_001","object":"response","created_at":1786347338,"status":"completed","model":"gpt-5.5","metadata":{"req_id":"req_001","session_id":"session_001","ripple_session_id":"session_001","shared_folder":"a-folder"},"output":[{"id":"msg_001","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","annotations":[],"text":"共享目录中共有 3 个文件。"}]}],"output_text":"共享目录中共有 3 个文件。","ripple_changed_files":null,"usage":{"input_tokens":1200,"output_tokens":80,"total_tokens":1280}}}
```

流结束标识：

```text
data: [DONE]
```
