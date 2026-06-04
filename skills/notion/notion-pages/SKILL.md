---
name: notion-pages
version: 1.0.0
description: "Use when a Notion task needs page creation, page search, page metadata, Markdown/body reads, block appends, block edits, or page archiving."
metadata:
  requires:
    bins: ["ntn"]
    connectors: ["notion"]
  cliHelp: "ntn pages --help"
---

# notion-pages：页面 CRUD

**CRITICAL — 开始前 MUST 先读取 [`../notion-shared/SKILL.md`](../notion-shared/SKILL.md)**，
其中包含 token 来源、权限错误处理（Integration 必须被 share 到目标 page）。

不确定参数 / schema 时，**先跑** `ntn pages --help` 或 `ntn api --docs /v1/pages -X POST` 再下手。

## 核心概念

Notion 的一个 page 由两部分组成：

| 部分 | 说明 | 对应 API |
|------|------|----------|
| **properties**（元数据） | 标题、状态、标签、日期等 schema 字段 | `v1/pages`（创建/修改） |
| **content**（正文） | Markdown 或 block 树：段落、标题、列表、代码块、引用... | `v1/pages/{page_id}/markdown` 或 `v1/blocks/{page_id}/children` |

创建 page 时可以同时传 `properties` + `children` / `markdown`。更新时按目标拆开：
改元数据走 `PATCH v1/pages/{page_id}`，追加结构化 block 走
`PATCH v1/blocks/{page_id}/children`，整体 Markdown 内容更新走
`PATCH v1/pages/{page_id}/markdown`。

## 搜索页面

### 按关键词

```bash
ntn api v1/search -d '{"query":"会议纪要","filter":{"value":"page","property":"object"}}'
```

`filter.value` 可选 `page` / `data_source`。不加 `filter` 就两种都返回。

### 列出 Integration 能访问的所有内容

```bash
ntn api v1/search -d '{}' | jq '.results[] | {id, object, url}'
```

如果这里返回空，八成是 Integration 还没被 share 到任何资源（见 notion-shared）。

## 创建 page

### 方式 A：从 Markdown 一键创建（推荐用于笔记类）

```bash
# parent 支持 page:<id>、database:<id>、data-source:<id>
ntn pages create --parent page:<PARENT_PAGE_ID> --json < /workspace/notes.md

# 短内容也可以直接传 --content
ntn pages create --parent page:<PARENT_PAGE_ID> --content $'# 今日会议纪要\n\n正文...' --json
```

当前 `ntn 0.10.0` 没有 `--markdown-file`、`--title`、`--parent-page-id` 这些 flag。
先跑 `ntn pages create --help` 确认当前版本支持的参数。

### 方式 B：raw API（精细控制 properties）

```bash
ntn api v1/pages -d '{
  "parent": {"page_id": "PARENT_ID"},
  "properties": {
    "title": {"title": [{"text": {"content": "今日会议纪要"}}]}
  },
  "content": [
    {"object":"block","type":"heading_1","heading_1":{"rich_text":[{"text":{"content":"讨论事项"}}]}},
    {"object":"block","type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"text":{"content":"…"}}]}}
  ]
}'
```

**硬规则**：
- `parent.page_id` 传的是 **父 page id**；要放进某个 data source 就优先用 `parent.data_source_id`
- 放进 data source 时，`properties` 必须严格对齐 data source schema
- `content` / `children` 数组一次最多 100 个 block，超过要拆多批走 `v1/blocks/{page_id}/children` 追加

## 读取 page

### 读 properties（page 元数据）

```bash
ntn api v1/pages/{page_id}
```

### 读正文（block 树）

优先读 Markdown（适合总结、问答、给用户展示）：

```bash
ntn api v1/pages/{page_id}/markdown
```

需要结构化 block 或递归子 block 时再拉 block 树：

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

### 用 Markdown 更新正文

```bash
ntn api -X PATCH v1/pages/{page_id}/markdown -d '{
  "type": "replace_content",
  "replace_content": {"new_str": "# 新标题\n\n新正文"}
}'
```

这是更新正文内容的高影响操作，执行前要向用户确认会替换/改写页面正文。

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
| "帮我把这段笔记存到 Notion" | `ntn pages create --parent page:<id> --json < notes.md` |
| "找一下叫 XX 的页面" | `ntn api v1/search -d '{"query":"XX"}'` |
| "这个页面里有什么？" | 优先 `ntn api v1/pages/{id}/markdown`，需要结构再拉 blocks |
| "在这个页面末尾加一段" | PATCH `v1/blocks/{id}/children`（追加） |
| "把这个页面归档" | PATCH `v1/pages/{id}` + `archived:true` + 用户确认 |
| 要过滤/排序 database / data source | 去 [`../notion-databases`](../notion-databases/SKILL.md) |
