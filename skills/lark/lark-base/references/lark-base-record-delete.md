# base +record-delete

> **前置条件：** 先阅读 [`../lark-shared/SKILL.md`](../../lark-shared/SKILL.md) 了解认证、全局参数和安全规则。

删除一条或多条记录。

## 推荐命令

```bash
lark-cli base +record-delete \
  --base-token <base_token> \
  --table-id <table_id> \
  --record-id <record_id> \
  --yes
```

```bash
lark-cli base +record-delete \
  --base-token app_xxx \
  --table-id tbl_xxx \
  --record-id rec_001 \
  --record-id rec_002 \
  --yes
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--base-token <token>` | 是 | Base Token |
| `--table-id <id_or_name>` | 是 | 表 ID 或表名 |
| `--record-id <id>` | 否 | 与 `--json` 二选一；记录 ID，可重复使用；这是主推荐用法 |
| `--json <object>` | 否 | 与 `--record-id` 二选一；脚本/代理场景可传 `{"record_id_list":["rec_xxx"]}` |

## API 入参详情

**HTTP 方法和路径：**

```http
POST /open-apis/base/v3/bases/:base_token/tables/:table_id/records/batch_delete
```

## 返回重点

- CLI 内部统一通过 `batch_delete` 删除记录；单个和多个 `--record-id` 使用相同的批量删除输出形态。
- 成功时直接返回接口 `data` 字段内容，通常包含 `record_id_list`。

## 工作流

> 这是**高风险写入操作**。CLI 层要求显式传 `--yes`；执行前必须向用户展示删除目标和风险，等用户明确二次确认后，才在原命令末尾追加 `--yes`。

1. 建议先用 `+record-get` 确认目标记录。
2. 目标记录明确后，也要等待用户二次确认删除；目标仍有歧义时，先继续追问或查询确认。

## 坑点

- ⚠️ 高风险写操作，删除后不可恢复。
- ⚠️ 忘记带 `--yes` 会被 CLI 拦截。

## 参考

- [lark-base-record.md](lark-base-record.md) — record 索引页
