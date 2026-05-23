---
name: gog-drive
version: 1.0.0
description: "用 gog 读/搜/上传/下载 Drive 文件。**先读 gog-shared**。对 delete/share/unshare/replace 写操作**必须先 AskUser 确认**。典型：搜近期发票 PDF 批量下载、上传 Markdown 自动转 Google Doc。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-drive

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 列文件（默认含 shared drives；--no-all-drives 只看 My Drive）
gog --account <email> --json drive ls --max 20
gog --account <email> --json drive ls --parent <folderId> --max 50

# 搜（支持 Google Drive 原生 query 语法，--raw-query 时）
gog --account <email> --json drive search "invoice"
gog --account <email> --json drive search "mimeType = 'application/pdf'" --raw-query

# 元数据
gog --account <email> --json drive get <fileId>
gog --account <email> drive url <fileId>   # 拼 Drive web URL

# 下载
gog --account <email> drive download <fileId> --out ./file.bin
gog --account <email> drive download <fileId> --format pdf --out ./doc.pdf   # Google Workspace 文件
gog --account <email> drive download <fileId> --format md --out ./note.md    # Google Doc → md

# 列 shared drives
gog --account <email> --json drive drives --max 100

# 权限
gog --account <email> --json drive permissions <fileId>
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 上传（新建文件）
gog --account <email> drive upload ./file.pdf --parent <folderId>

# 上传并转换（Markdown → Google Doc）
gog --account <email> drive upload ./notes.md --convert

# 替换文件内容（保留 file ID 和 share link）
gog --account <email> drive upload ./new-version.pdf --replace <fileId>  # ⚠️

# 删除（默认 trash；--permanent 硬删）
gog --account <email> drive delete <fileId>           # ⚠️
gog --account <email> drive delete <fileId> --permanent  # ⚠️⚠️

# 分享
gog --account <email> drive share <fileId> --to user --email a@b.com --role reader    # ⚠️
gog --account <email> drive share <fileId> --to domain --domain example.com --role reader  # ⚠️

# 取消分享
gog --account <email> drive unshare <fileId> --permission-id <permId>  # ⚠️

# 组织
gog --account <email> drive mkdir "New Folder" --parent <parentFolderId>
gog --account <email> drive rename <fileId> "New Name"  # ⚠️（无歧义时也建议）
gog --account <email> drive move <fileId> --parent <destFolderId>  # ⚠️
```

## 典型场景

**场景：批量下载近期发票 PDF**
```bash
gog --account <email> --json drive search "invoice filetype:pdf newer_than:30d" --max 50 \
  | jq -r '.files[].id' \
  | while read fid; do
      gog --account <email> drive download "$fid" --out "/workspace/invoices/$fid.pdf"
    done
```

**场景：Markdown 报告发到 Drive 并分享**
1. `gog drive upload ./report.md --convert --parent <folderId>` → 拿到 fileId
2. AskUser 确认分享对象和权限
3. `gog drive share <fileId> --to user --email stakeholder@x.com --role reader`

## 注意

- `--convert` 前 gogcli 默认剥离 Markdown 开头的 YAML frontmatter（`---` ~ `---`）；需要保留时加 `--keep-frontmatter`。
- Drive search query 语法：`mimeType = '...'`, `name contains '...'`, `parents in '...'` —— 用 `--raw-query` 时直接透传。
