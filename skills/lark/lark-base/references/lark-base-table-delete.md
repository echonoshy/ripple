# base +table-delete

> **前置条件：** 先阅读 [`../lark-shared/SKILL.md`](../../lark-shared/SKILL.md) 了解认证、全局参数和安全规则。

删除一张表。

## 推荐命令

```bash
lark-cli base +table-delete \
  --base-token app_xxx \
  --table-id tbl_xxx \
  --yes
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--base-token <token>` | 是 | Base Token |
| `--table-id <id_or_name>` | 是 | 表 ID 或表名 |

## API 入参详情

**HTTP 方法和路径：**

```
DELETE /open-apis/base/v3/bases/:base_token/tables/:table_id
```

## 返回重点

- 返回 `deleted: true` 以及删除目标的 `table_id / table_name`。

## 工作流

> 这是**高风险写入操作**。CLI 层要求显式传 `--yes`；执行前必须向用户展示删除表和风险，等用户明确二次确认后，才在原命令末尾追加 `--yes`。

1. 建议先用 `+table-list` 或 `+table-get` 确认目标。
2. 目标表明确后，也要等待用户二次确认删除；目标表仍有歧义时，先继续追问或查询确认。

## 坑点

- ⚠️ 高风险不可逆操作。
- ⚠️ 删除场景强烈建议传 `tbl_xxx`，不要传表名。
- ⚠️ 忘记带 `--yes` 会被 CLI 拦截。

## 参考

- [lark-base-table.md](lark-base-table.md) — table 索引页
- [lark-base-table-list.md](lark-base-table-list.md) — 列表
