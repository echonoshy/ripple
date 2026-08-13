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
  "model": "gpt-5.5",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "请总结这个共享目录中的文件"
        }
      ]
    }
  ],
  "stream": true,
  "instructions": "使用中文回答，先给结论，再列出参考过的文件。",
  "reasoning": {
    "effort": "medium"
  },
  "metadata": {
    "req_id": "req_001",
    "ripple_session_id": "session_001",
    "shared_folder": "a-folder"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `input` | string / Responses input | 是 | 本轮用户输入，格式与 Responses API 的 `input` 接近 |
| `model` | string | 否 | 指定模型；未传时使用服务端默认模型 |
| `stream` | boolean | 否 | 为兼容 Responses 请求而接受；接口始终返回 SSE，传入值不改变响应模式 |
| `instructions` | string | 否 | 本轮回答的语言、格式、长度和结构要求；不能覆盖共享目录只读、无网络和不可越界等服务端安全规则 |
| `reasoning` | object | 否 | 推理配置 |
| `reasoning.effort` | string | 否 | 推理等级，例如 `low`、`medium`、`high` |
| `metadata.req_id` | string | 否 | 请求标识，用于日志和问题定位；缺失时由服务端生成，不参与幂等控制 |
| `metadata.ripple_session_id` | string | 是 | 会话标识，用于保持上下文；同一 session 固定绑定一个共享目录 |
| `metadata.shared_folder` | string | 是 | 共享目录名称，例如 `a-folder`；只允许一级目录标识 |


字段约束：

- `metadata.ripple_session_id`：`^[a-zA-Z0-9_-]{1,64}$`
- `metadata.shared_folder`：`^[a-zA-Z0-9_-]{1,64}$`
- `metadata.req_id`：1～256 个可打印字符；缺失时由服务端生成 UUID
- 同一个 `ripple_session_id` 后续请求必须继续使用首次绑定的 `shared_folder`
- 需要切换共享目录时，调用方必须创建新的 `ripple_session_id`
- 迁移期间继续接受旧顶层 `req_id`、`session_id`、`shared_folder`；新旧位置同时传入且值不一致时返回 `400`
- 未声明的 Responses 顶层字段和未知 metadata 字段会被忽略，不会因为字段多余返回错误
- `instructions` 只对当前 turn 生效；空白字符串等同于未传入

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
