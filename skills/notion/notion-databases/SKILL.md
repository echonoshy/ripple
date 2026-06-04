---
name: notion-databases
version: 1.0.0
description: "Use when a Notion task needs database or data source schema, filtered queries, sorted rows, pagination, row creation, or row property updates."
metadata:
  requires:
    bins: ["ntn"]
    connectors: ["notion"]
  cliHelp: "ntn datasources --help"
---

# notion-databases：数据库 / data source 查询与写入

**CRITICAL — 开始前 MUST 先读取 [`../notion-shared/SKILL.md`](../notion-shared/SKILL.md)**。

写 filter/sort JSON 前**务必**先跑 `ntn api --docs /v1/data_sources/{data_source_id}/query -X POST`
对照官方 schema，不要凭记忆写。

## 基础概念

- 当前 Notion API 把 **database** 和 **data source** 拆开了
- database 是容器；实际 schema、filter、sort、query 主线在 data source 上
- data source 的每一行（row）就是一个 page，`parent.type = data_source_id`
- 每个"列"就是该 page 的一个 property，类型由 data source schema 决定
  （`title` / `rich_text` / `number` / `select` / `multi_select` / `date` / `status` / `checkbox` / `relation` / ...）

如果用户给的是 database id / URL，先读取 database，拿到里面的 data source：

```bash
ntn api v1/databases/{database_id} | jq '.data_sources[] | {id, name}'
```

如果只有一个 data source，通常直接用它；如果有多个，先列出来让用户确认。

## 读取 data source schema

先看它长什么样才能写对 filter 和 properties：

```bash
ntn api v1/data_sources/{data_source_id}
```

关键看 `properties` 对象，每个 key 是列名，每个 value 里的 `type` 是列类型。
**column 类型决定了 filter 语法**（下面会分开讲）。

## 查询（filter + sort + 分页）

### 最小例子

```bash
ntn api v1/data_sources/{data_source_id}/query -d '{
  "filter": {"property": "Status", "select": {"equals": "In Progress"}},
  "sorts": [{"property": "Updated", "direction": "descending"}],
  "page_size": 50
}'
```

CLI shortcut 也可以：

```bash
ntn datasources query <data-source-id> \
  --filter '{"property":"Status","select":{"equals":"In Progress"}}' \
  --sort "Updated desc" \
  --limit 50 \
  --json
```

### filter 常用套路（按 column 类型）

| column 类型 | filter 写法 |
|-------------|-------------|
| `title` / `rich_text` | `{"property":"Name","rich_text":{"contains":"关键词"}}` |
| `select` | `{"property":"Status","select":{"equals":"Done"}}` |
| `multi_select` | `{"property":"Tags","multi_select":{"contains":"urgent"}}` |
| `number` | `{"property":"Priority","number":{"greater_than":3}}` |
| `date` | `{"property":"Due","date":{"on_or_before":"2026-12-31"}}` |
| `checkbox` | `{"property":"Done","checkbox":{"equals":true}}` |

**组合**（AND / OR）：

```json
{"filter":{"and":[
  {"property":"Status","select":{"equals":"Todo"}},
  {"property":"Due","date":{"on_or_before":"2026-06-01"}}
]}}
```

`or` 同理。AND/OR 可以嵌套两层。

### 分页

和 notion-cli skill 说的一样，`has_more=true` → 用 `next_cursor` 继续：

```bash
ntn api v1/data_sources/{data_source_id}/query -d '{
  "page_size": 100,
  "start_cursor": "<上一页的 next_cursor>"
}'
```

单次上限 **100**，别硬塞更大的数字。

## 向 data source 新增一行

等价于"创建一个 parent 是 data source 的 page"，properties **必须严格对齐**
schema（字段名、类型都要对）：

```bash
ntn api v1/pages -d '{
  "parent": {"data_source_id": "DATA_SOURCE_ID"},
  "properties": {
    "Name":   {"title":     [{"text":{"content":"今日 TODO"}}]},
    "Status": {"select":    {"name": "Todo"}},
    "Tags":   {"multi_select":[{"name":"work"}, {"name":"urgent"}]},
    "Due":    {"date":      {"start":"2026-05-01"}},
    "Done":   {"checkbox":  false}
  }
}'
```

**常见翻车**：
- `select` / `multi_select` 的 `name` 必须是 data source 里**已存在**的选项值（否则报 `validation_error`）
- 标题字段的 key 不一定叫 `Name`，具体以 data source schema 为准
- `relation` 字段的值是一个对象数组 `[{"id":"PAGE_ID"}]`，不是字符串

## 修改一行

本质是"改 page 的 properties"。见
[`../notion-pages`](../notion-pages/SKILL.md) 的"改 properties（PATCH）"段落。

## 归档一行

PATCH page + `archived:true`，同样见 notion-pages。

## 快速决策

| 用户说... | 做什么 |
|-----------|--------|
| "这个数据库有什么字段？" | 先 `v1/databases/{id}` 找 data source，再 `v1/data_sources/{id}` 看 schema |
| "按 XX 条件拉一批" | `v1/data_sources/{id}/query` + 对应 type 的 filter |
| "按时间排序给我列表" | 在 `sorts` 里加 `{"property":"XX","direction":"descending"}` |
| "加一条新记录" | `ntn api v1/pages` + `parent.data_source_id` |
| "把这条改成 Done" | PATCH `v1/pages/{row_id}` + 新 properties |
| "清空这个数据库" | 循环 archive 每一行 + **先跟用户确认**，不要擅自批量处理 |

## 最后的提醒

填 filter/properties 之前读一遍 schema，能少走 80% 的弯路。
不确定就 `ntn api --docs /v1/data_sources/{id}/query -X POST` 现查一下文档。
