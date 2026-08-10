# 聊天打断与再次请求报文

## 打断请求

```http
POST /v1/sessions/{session_id}/stop HTTP/1.1
Host: ripple-server.example.com
Authorization: Bearer <api-key>
X-Ripple-User-Id: user_123
Content-Length: 0
```

## 打断响应

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "session_id": "session_123",
  "stopped": true,
  "job_id": "agent_a1b2c3d4",
  "status": "cancelled",
  "connector_auth_cancelled": false,
  "connector": null
}
```

## 被打断请求的 SSE 结束响应

```text
data: {"error":{"message":"Codex run failed","type":"cancelled"},"event_version":1}

data: [DONE]
```

## 使用同一 Session 再次请求

```http
POST /v1/responses HTTP/1.1
Host: ripple-server.example.com
Authorization: Bearer <api-key>
X-Ripple-User-Id: user_123
Content-Type: application/json

{
  "model": "codex",
  "input": [
    {
      "role": "user",
      "content": "新的问题"
    }
  ],
  "stream": true,
  "previous_response_id": "resp_session_123",
  "metadata": {
    "ripple_session_id": "session_123"
  }
}
```

## 再次请求的 SSE 响应

```text
event: response.created
data: {"type":"response.created","response":{"id":"resp_session_123","object":"response","created_at":1786328719,"status":"in_progress","model":"codex","metadata":{"ripple_session_id":"session_123"}}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","response_id":"resp_session_123","item_id":"msg_123","output_index":0,"content_index":0,"delta":"新的回答"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_session_123","object":"response","created_at":1786328720,"status":"completed","model":"codex","output":[{"id":"msg_123","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"新的回答","annotations":[]}]}],"output_text":"新的回答","usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":15},"metadata":{"ripple_session_id":"session_123"},"ripple_changed_files":null}}

data: [DONE]
```
