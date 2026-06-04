# base +field-delete

> **前置条件：** 先阅读 [`../lark-shared/SKILL.md`](../../lark-shared/SKILL.md) 了解认证、全局参数和安全规则。

删除一个字段。

## 推荐命令

```bash
lark-cli base +field-delete \
  --base-token app_xxx \
  --table-id tbl_xxx \
  --field-id fld_xxx \
  --yes
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--base-token <token>` | 是 | Base Token |
| `--table-id <id_or_name>` | 是 | 表 ID 或表名 |
| `--field-id <id_or_name>` | 是 | 字段 ID 或字段名 |

## API 入参详情

**HTTP 方法和路径：**

```
DELETE /open-apis/base/v3/bases/:base_token/tables/:table_id/fields/:field_id
```

## 返回重点

- 返回 `deleted: true` 和目标字段标识。

## 工作流

> 这是**高风险写入操作**。CLI 层要求显式传 `--yes`；执行前必须向用户展示删除字段和风险，等用户明确二次确认后，才在原命令末尾追加 `--yes`。

1. 建议先用 `+field-get` 或 `+field-list` 确认目标字段。
2. 字段目标明确后，也要等待用户二次确认删除；字段目标仍有歧义时，先继续追问或查询确认。

## 坑点

- ⚠️ 高风险写操作，删除后不可恢复。
- ⚠️ 忘记带 `--yes` 会被 CLI 拦截。

## 参考

- [lark-base-field.md](lark-base-field.md) — field 索引页
