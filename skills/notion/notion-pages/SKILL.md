---
name: notion-pages
version: 1.0.0
description: "Notion 页面（page）CRUD：创建 page（从 Markdown 或结构化 properties）、搜索 page、读取 page 属性和 block 树、追加/修改 block 内容、归档 page。当用户需要创建会议纪要/笔记/文档、搜索某个 page、读取 page 内容、向 page 追加段落、归档 page 时使用。"
metadata:
  requires:
    bins: ["ntn"]
  cliHelp: "ntn pages --help"
---

# notion-pages：页面 CRUD

**CRITICAL — 开始前 MUST 先用 Read 工具读取 [`../notion-shared/SKILL.md`](../notion-shared/SKILL.md)**，
其中包含 token 来源、权限错误处理（Integration 必须被 share 到目标 page）。

不确定参数 / schema 时，**先跑** `ntn pages --help` 或 `ntn api --docs v1/pages` 再下手。

## 核心概念

Notion 的一个 page 由两部分组成：

| 部分 | 说明 | 对应 API |
|------|------|----------|
| **properties**（元数据） | 标题、状态、标签、日期等 schema 字段 | `v1/pages`（创建/修改） |
| **content**（block 树） | 正文内容：段落、标题、列表、代码块、引用... | `v1/blocks/{page_id}/children` |

一次请求只能操作其中**一部分**，不能一股脑塞在一起（这是 Notion API 的硬约束）。

## 搜索页面

### 按关键词

```bash
ntn api v1/search -d '{"query":"会议纪要","filter":{"value":"page","property":"object"}}'
```

`filter.value` 可选 `page` / `database`。不加 `filter` 就两种都返回。

### 列出 Integration 能访问的所有内容

```bash
ntn api v1/search -d '{}' | jq '.results[] | {id, object, title: .properties.title}'
```

如果这里返回空，八成是 Integration 还没被 share 到任何资源（见 notion-shared）。

## 创建 page

### 方式 A：从 Markdown 一键创建（推荐用于笔记类）

```bash
# ntn 有官方 shortcut：
ntn pages create --parent-page-id <PARENT_PAGE_ID> --title "今日会议纪要" --markdown-file /workspace/notes.md
```

先跑 `ntn pages create --help` 确认你手里的 ntn 版本支持哪些 flag（版本间略有差异）。

### 方式 B：raw API（精细控制 properties）

```bash
ntn api v1/pages -d '{
  "parent": {"page_id": "PARENT_ID"},
  "properties": {
    "title": [{"text": {"content": "今日会议纪要"}}]
  },
  "children": [
    {"object":"block","type":"heading_1","heading_1":{"rich_text":[{"text":{"content":"讨论事项"}}]}},
    {"object":"block","type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"text":{"content":"…"}}]}}
  ]
}'
```

**硬规则**：
- `parent.page_id` 传的必须是 **父 page id**；要放进某个数据库就用 `parent.database_id`（此时 properties 必须严格对齐数据库 schema）
- `children` 数组一次最多 100 个 block，超过要拆多批走 `v1/blocks/{page_id}/children` 追加

## 读取 page

### 读 properties（page 元数据）

```bash
ntn api v1/pages/{page_id}
```

### 读正文（block 树）

```bash
ntn api v1/blocks/{page_id}/children page_size==100
```

block 里如果有 `has_children=true`，就要递归 `ntn api v1/blocks/{child_id}/children` 继续拉。
深层嵌套的 page（toggle、column_list、column 等）都会套多层。

**批量读取建议**：拉下来后 `jq` 处理，不要在 prompt 里嵌原始 JSON 回显。

## 修改 page

### 改 properties（PATCH）

```bash
ntn api -X PATCH v1/pages/{page_id} -d '{
  "properties": {
    "Status": {"select": {"name": "Done"}}
  }
}'
```

### 归档（Notion 里"删除"的标准做法）

```bash
ntn api -X PATCH v1/pages/{page_id} -d '{"archived": true}'
```

Notion 没有真·硬删除接口，`archived=true` 就是标准回收站语义。执行前**必须**
向用户确认。

### 追加 block（不能直接改 properties 里的"内容"，只能操作 block 树）

```bash
ntn api -X PATCH v1/blocks/{page_id}/children -d '{
  "children": [
    {"object":"block","type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"补充一段"}}]}}
  ]
}'
```

### 改单个 block 的内容

```bash
ntn api -X PATCH v1/blocks/{block_id} -d '{
  "paragraph": {"rich_text": [{"text":{"content":"改过的内容"}}]}
}'
```

type 字段必须和原 block 类型一致，不能把 `paragraph` 改成 `heading_1`（那得删重建）。

## URL → page_id 解析

用户给你的 page URL 长这样：

```
https://www.notion.so/workspace-name/Some-Title-32-chars-hex-id
https://www.notion.so/workspace-name/d8f4e2c1a6b048cfb72dd3f9e0a1b2c3
```

末尾那串 **32 位无连字符 hex** 就是 page_id。使用时通常要加上连字符变成 UUID：
`d8f4e2c1-a6b0-48cf-b72d-d3f9e0a1b2c3`。

也可以直接把带连字符/不带连字符的都丢给 `ntn api v1/pages/{id}`，ntn 会兼容两种写法。

## 快速决策

| 用户说... | 跑什么 |
|-----------|--------|
| "帮我把这段笔记存到 Notion" | `ntn pages create --markdown-file ...` |
| "找一下叫 XX 的页面" | `ntn api v1/search -d '{"query":"XX"}'` |
| "这个页面里有什么？" | `ntn api v1/blocks/{id}/children page_size==100` |
| "在这个页面末尾加一段" | PATCH `v1/blocks/{id}/children`（追加） |
| "把这个页面归档" | PATCH `v1/pages/{id}` + `archived:true` + 用户确认 |
| 要过滤/排序 database | 去 [`../notion-databases`](../notion-databases/SKILL.md) |
