---
name: gog-slides
version: 1.1.0
description: "用 gog 读/创建/改 Google Slides。**先读 gog-shared**。create/create-from-markdown/copy/replace-text/delete **必须先向用户确认并停止，下一轮明确同意后再执行；优先 --dry-run**。典型：从 markdown 生成演示文稿、按 template 替换占位符、导出 PDF。"
metadata:
  requires:
    bins: ["gog"]
    connectors: ["google_workspace"]
---

# gog-slides

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元数据（slides 列表、speaker notes 快览）
gog --account <email> --json slides info <presentationId>

# 某张 slide
gog --account <email> --json slides read-slide <presentationId> <slideId>

# 导出
gog --account <email> slides export <presentationId> --format pdf --out ./deck.pdf
gog --account <email> slides export <presentationId> --format pptx --out ./deck.pptx
```

## 写操作（⚠️ 必须先确认）

```bash
# 新建 presentation
gog --account <email> slides create "Q2 Review"

# 复制 template
gog --account <email> slides copy <templateId> "Q2 Review from template"

# Replace Text（必须显式指定范围；整份文稿使用 --all，先 --dry-run）
gog --account <email> slides replace-text <presentationId> "{{quarter}}" "Q2 2026" --all --dry-run
gog --account <email> slides replace-text <presentationId> "{{quarter}}" "Q2 2026" --all

# 从 Markdown 创建 presentation（先 --dry-run）
gog --account <email> slides create-from-markdown "Q2 Review" --content-file ./deck.md --dry-run
gog --account <email> slides create-from-markdown "Q2 Review" --content-file ./deck.md

# 删除 slide
gog --account <email> slides delete-slide <presentationId> <slideId>  # ⚠️
```

## 典型场景

**场景：从 template 批量生成演示文稿**
1. `slides info <templateId>` → 看 template 里有哪些占位符（如 `{{client}}`、`{{quarter}}`）
2. `slides copy <templateId> "Client ABC Q2"` → 新 presentationId
3. 把替换计划列出来并确认：`{{client}} → ABC`, `{{quarter}} → Q2 2026`
4. `slides replace-text ... --all` 逐个替换

**场景：把 markdown 大纲变成演示文稿**
1. 让用户把大纲 paste 进来
2. 在 `/workspace/deck.md` 里整理 Markdown
3. `slides create-from-markdown "<title>" --content-file ./deck.md --dry-run` 先 preview
4. 确认结构，停止等待用户下一轮明确同意
5. 去掉 `--dry-run` 真跑

## 注意

- 修改 template 时优先使用带明确范围的 `replace-text`；整份文稿必须显式传 `--all`。
- 复杂元素编辑先用 `slides element --help` / `slides table --help` 查询当前命令面，不要拼旧版 batchUpdate 请求。
