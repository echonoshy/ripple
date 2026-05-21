---
name: gog-docs
version: 1.0.0
description: "用 gog 读/写 Google Docs。**先读 gog-shared**。对 update/write/sed/find-replace **必须先 AskUser 确认 + 优先 --dry-run**。典型：读全文、追加段落、template 填充、找替换。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-docs

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元信息
gog --account <email> --json docs info <docId>

# 读全文（默认 plain text）
gog --account <email> docs cat <docId>
gog --account <email> docs cat <docId> --max-bytes 10000     # 限制输出大小
gog --account <email> docs cat <docId> --tab "Notes"          # 特定 tab
gog --account <email> docs cat <docId> --all-tabs

# 列 tabs
gog --account <email> --json docs list-tabs <docId>

# 导出
gog --account <email> docs export <docId> --format md --out ./doc.md
gog --account <email> docs export <docId> --format pdf --out ./doc.pdf
gog --account <email> docs export <docId> --format docx --out ./doc.docx
gog --account <email> docs export <docId> --format html --out ./doc.html
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建
gog --account <email> docs create "My Doc"
gog --account <email> docs create "My Doc" --file ./source.md  # 从 markdown 导入

# 复制
gog --account <email> docs copy <docId> "Copy Name"

# 追加文本
gog --account <email> docs update <docId> --text "append this"
gog --account <email> docs update <docId> --file ./insert.txt --index 25

# 覆盖 / 重写
gog --account <email> docs write <docId> --text "fresh content"         # ⚠️
gog --account <email> docs write <docId> --file ./body.md --replace --markdown  # ⚠️

# Find/Replace（⚠️⚠️ 整篇文档都替换，先 --dry-run）
gog --account <email> docs find-replace <docId> "old" "new"
gog --account <email> docs find-replace <docId> "old" "new" --tab-id t.notes

# Sed（sedmat 语法，支持格式化：**bold** / *italic* / ~~strike~~ / `mono` / 链接 / 图片 / 表格）
gog --account <email> docs sed <docId> 's/pattern/replacement/g'
gog --account <email> docs sed <docId> 's/Google/[Google](https://google.com)/'
gog --account <email> docs sed <docId> 's/{{LOGO}}/![](https://x.com/logo.png)/'
```

## 典型场景

**场景：把 `/workspace/report.md` 替换成某个 doc 的全文**
1. AskUser 确认要替换的 doc（拿 `docs info` 给看标题）
2. `gog docs write <docId> --file /workspace/report.md --replace --markdown`

**场景：从 template 批量生成 doc**
1. `gog docs copy <templateDocId> "Q2 Report"` → 拿新 docId
2. `gog docs find-replace <newDocId> "{{quarter}}" "Q2 2026"`
3. ... 重复若干次 ...
（每组替换前 AskUser 一次，或把所有替换汇总一次 AskUser）

## 注意

- `sed` 的 sedmat 语法很强（表格单元格、行列操作、图片宽度），复杂用法先 `gog docs sed --help`。
- `--markdown` 只在 write/update 且源是 markdown 时加；不加时 gog 当纯文本插入。
