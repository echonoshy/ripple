---
name: notion-cli
version: 1.0.0
description: "通用 `ntn api` 调用指南：如何通过 Notion CLI 直接请求任意 API endpoint、拼 GET query / POST body 的三种写法、method 推断规则、常见响应处理、分页。当用户要 \"调 Notion API\"、\"ntn api\"、或需要用到没有专门封装的 endpoint 时使用。"
metadata:
  requires:
    bins: ["ntn"]
  cliHelp: "ntn api --help"
---

# notion-cli：通用 API 调用

**CRITICAL — 开始前 MUST 先用 Read 工具读取 [`../notion-shared/SKILL.md`](../notion-shared/SKILL.md)**，
其中包含 token 来源、self-document 原则、权限错误处理。

## `ntn api` 的三种书写形式

### 1. GET with query param（`key==value` 双等号）

```bash
ntn api v1/users page_size==100
ntn api v1/search query==="meeting notes" page_size==20
```

注意：是 **`==`**（查询参数），不是 `=`（body 字段）。这是 `ntn` 用来区分
query/body 的关键语法。

### 2. POST with inline body fields（`key=value` 单等号）

```bash
# 创建 page（简单版）
ntn api v1/pages parent[page_id]=abc123 properties[title][0][text][content]="Hello"
```

`key=value` 会被拼进 JSON body 里。支持方括号语法表达嵌套。但**超过两层嵌套**
（比如 rich_text、filter、sort）就别硬拼字符串了，改用下面的 JSON 形式。

### 3. POST with JSON body（推荐用于任何非平凡请求）

```bash
# 从 stdin 传 JSON
echo '{"parent":{"page_id":"abc123"},"properties":{...}}' | ntn api v1/pages -d @-

# 或者内联
ntn api v1/pages -d '{"parent":{"page_id":"abc123"},"properties":{"title":[{"text":{"content":"Hi"}}]}}'

# 或者从文件
ntn api v1/pages -d @payload.json
```

> 遇到复杂 body（filter/sort/rich_text/children blocks），**一律**走 JSON，
> 不要硬拼 inline 字段。先写到 `/workspace/tmp.json` 再 `-d @tmp.json`，
> 可读性和可调试性都更好。

## Method 推断规则

`ntn` 默认：
- 没有 body → GET
- 有 body（`-d` 或 inline `key=value`）→ POST

显式指定用 `-X METHOD`：

```bash
ntn api -X PATCH v1/pages/abc123 -d '{"archived":true}'
ntn api -X DELETE v1/blocks/xxx
```

Notion 里**改**东西绝大多数用 `PATCH`，不是 `PUT`。不确定就先 `ntn api --help <endpoint>` 查。

## 常见响应模式

### 成功返回

```json
{"object": "page", "id": "xxx", ...}
```

### 错误（都统一带 `"object": "error"`）

```json
{"object": "error", "status": 400, "code": "validation_error", "message": "..."}
```

**错误码速查**：

| code | 含义 | 处理 |
|------|------|------|
| `unauthorized` | token 无效 / 过期 | 用一句话请用户把新 token 直接粘到对话里 → 收到后调 `NotionTokenSet` 工具覆盖（详见 notion-shared） |
| `restricted_resource` / `object_not_found` | Integration 未被 share 到该资源 | 引导用户在 Notion 里 share（见 notion-shared） |
| `validation_error` | 请求 body/params 结构错 | 重新跑 `ntn api --docs <endpoint>` 对照 schema |
| `rate_limited` | 触发 3 req/s 限速 | 退避 1-2s 重试，不要死循环 |
| `conflict_error` | 并发写冲突 | 重试（通常 1 次足够） |

## 分页（`has_more` + `next_cursor`）

Notion 很多 list 类 endpoint 默认 100 条，要翻页：

```bash
# 第一页
ntn api v1/databases/xxx/query -d '{"page_size":100}' > page1.json

# 用上一页的 next_cursor 拉下一页
CURSOR=$(jq -r '.next_cursor' page1.json)
ntn api v1/databases/xxx/query -d "{\"page_size\":100,\"start_cursor\":\"$CURSOR\"}" > page2.json
```

只要 `has_more: true` 就继续。**不要**一次把 `page_size` 拉到 1000 试图绕过
（Notion 硬上限 100，超过会直接 400）。

## 快速决策

| 用户意图 | 优先走 |
|----------|--------|
| "看看我 Notion 里有什么" | `ntn api v1/search -d '{"query":"..."}'` |
| "列出所有 Integration 能看到的页" | `ntn api v1/search -d '{}'` |
| "读某个 page 的内容" | `ntn api v1/blocks/{page_id}/children page_size==100` 拉 block 树 |
| 明确知道是 page 操作 | 去 [`../notion-pages`](../notion-pages/SKILL.md) |
| 明确知道是 database 查询 | 去 [`../notion-databases`](../notion-databases/SKILL.md) |
| 涉及文件上传 | 去 [`../notion-files`](../notion-files/SKILL.md) |

## 调试姿势

写不对一个请求时，按顺序做：

1. `ntn api --help <endpoint>` — 看方法和必需字段
2. `ntn api --docs <endpoint>` — 读官方描述
3. `ntn api --spec <endpoint>` — 看 JSON schema
4. 把 body 先写到 `/workspace/tmp.json`，再 `ntn api ... -d @/workspace/tmp.json`
5. 失败后把返回的 error message 原样贴出来，再查

**不要**在连续两次请求都失败的情况下开始瞎猜字段名 —— 回到 step 1。
