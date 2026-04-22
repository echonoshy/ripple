---
name: gog-sheets
version: 1.0.0
description: "用 gog 读/写 Google Sheets。**先读 gog-shared**。对 update/append/clear/delete-tab/format **必须先 AskUser 确认**。典型：读 range、append 一行、从 CSV 覆盖、按命名区间写入、插入/删除 tab。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-sheets

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元数据（列所有 tab / sheet ID / range）
gog --account <email> --json sheets metadata <ssId>

# 读 range
gog --account <email> --json sheets get <ssId> 'Sheet1!A1:C20'
gog --account <email> --json sheets get <ssId> MyNamedRange

# 格式信息
gog --account <email> --json sheets read-format <ssId> 'Sheet1!A1:B2'
gog --account <email> --json sheets read-format <ssId> 'Sheet1!A1:B2' --effective

# 命名区间 / charts
gog --account <email> --json sheets named-ranges <ssId>
gog --account <email> --json sheets chart list <ssId>
gog --account <email> --json sheets chart get <ssId> <chartId>

# 注释 / 链接
gog --account <email> --json sheets notes <ssId> 'Sheet1!A1:B10'
gog --account <email> --json sheets links <ssId> 'Sheet1!A1:B10'

# 导出（via Drive）
gog --account <email> sheets export <ssId> --format pdf --out ./s.pdf
gog --account <email> sheets export <ssId> --format xlsx --out ./s.xlsx
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 更新（管道/逗号 格式：`row1col1|row1col2,row2col1|row2col2`）
gog --account <email> sheets update <ssId> 'Sheet1!A1' 'v1|v2,v3|v4'

# 用 JSON 更新（更清晰）
gog --account <email> sheets update <ssId> 'Sheet1!A1:B2' --values-json '[["a","b"],["c","d"]]'

# Append
gog --account <email> sheets append <ssId> 'Sheet1!A:C' 'new|row|data'

# Clear（⚠️⚠️）
gog --account <email> sheets clear <ssId> 'Sheet1!A1:B10'
gog --account <email> sheets clear <ssId> MyNamedRange

# Find/Replace
gog --account <email> sheets find-replace <ssId> "old" "new"
gog --account <email> sheets find-replace <ssId> "old" "new" --sheet Sheet1 --regex

# Tab 管理
gog --account <email> sheets add-tab <ssId> "NewTab" --index 0
gog --account <email> sheets rename-tab <ssId> "Old" "New"
gog --account <email> sheets delete-tab <ssId> "OldTab" --force  # ⚠️⚠️

# Format
gog --account <email> sheets format <ssId> 'Sheet1!A1:B2' \
  --format-json '{"textFormat":{"bold":true}}' \
  --format-fields 'userEnteredFormat.textFormat.bold'
gog --account <email> sheets merge <ssId> 'Sheet1!A1:B2'
gog --account <email> sheets freeze <ssId> --rows 1 --cols 1
gog --account <email> sheets number-format <ssId> 'Sheet1!C:C' --type CURRENCY --pattern '$#,##0.00'

# 创建新 spreadsheet
gog --account <email> sheets create "New Spreadsheet" --sheets "Sheet1,Sheet2"
```

## 典型场景

**场景：把 `/workspace/data.csv` 写进 Sheet1 A1 起**
1. `cat /workspace/data.csv | tr ',' '|'` 预览（AskUser 看一行是不是对的）
2. AskUser 确认目标 range
3. `cat /workspace/data.csv | tr ',' '|' | gog --account <email> sheets update <ssId> 'Sheet1!A1'`

**场景：给某列加货币格式**
1. `sheets metadata` 先确认 sheet 名和列范围
2. AskUser 确认要改的范围 + 格式
3. `sheets number-format <ssId> 'Revenue!C:C' --type CURRENCY --pattern '$#,##0.00'`

## 注意

- `--values-json` 输入是**二维数组**（行 → 列）；不是对象。
- Range 语法：`Sheet1!A1:B10`（tab 名+!+范围），或直接用命名区间名。
- 格式化的 `--format-fields` 必须精确到要改的叶子字段（gogcli 透传给 Sheets API 的 fieldMask）。
