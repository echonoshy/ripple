---
name: gog-slides
version: 1.0.0
description: "用 gog 读/创建/改 Google Slides。**先读 gog-shared**。create/update/delete/find-replace/batch-update **必须先 AskUser 确认 + 优先 --dry-run**。典型：从 markdown 生成演示文稿骨架、按 template 替换占位符、导出 PDF。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-slides

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元数据（slides 列表、speaker notes 快览）
gog --account <email> --json slides info <presentationId>

# 某张 slide
gog --account <email> --json slides slide <presentationId> <slideId>

# 导出
gog --account <email> slides export <presentationId> --format pdf --out ./deck.pdf
gog --account <email> slides export <presentationId> --format pptx --out ./deck.pptx
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建 presentation
gog --account <email> slides create "Q2 Review"

# 复制 template
gog --account <email> slides copy <templateId> "Q2 Review from template"

# Find/Replace（整份文稿替换，先 --dry-run）
gog --account <email> slides find-replace <presentationId> "{{quarter}}" "Q2 2026"
gog --account <email> slides find-replace <presentationId> "{{quarter}}" "Q2 2026" --dry-run

# 批量修改（gog 透传 Slides API 的 batchUpdate request list）
gog --account <email> slides batch-update <presentationId> --file ./requests.json  # ⚠️⚠️

# 删除 slide
gog --account <email> slides delete-slide <presentationId> <slideId>  # ⚠️
```

## 典型场景

**场景：从 template 批量生成演示文稿**
1. `slides info <templateId>` → 看 template 里有哪些占位符（如 `{{client}}`、`{{quarter}}`）
2. `slides copy <templateId> "Client ABC Q2"` → 新 presentationId
3. AskUser 把替换计划列出来：`{{client}} → ABC`, `{{quarter}} → Q2 2026`
4. `slides find-replace` 逐个替换

**场景：把 markdown 大纲变成演示文稿**（**依赖模型的 batchUpdate JSON 能力，难度高，先试 --dry-run**）
1. 让用户把大纲 paste 进来
2. 在 `/workspace/slides-requests.json` 里生成 `createSlide` + `insertText` request 数组
3. `slides batch-update --file ... --dry-run` 先 preview
4. AskUser 确认结构
5. 去掉 `--dry-run` 真跑

## 注意

- Slides API 的 batchUpdate 很强但也很容易写错；**优先 find-replace 改 template** 而不是从零 batchUpdate。
- 图片/形状坐标用 EMU（1 inch = 914400 EMU），容易算错，先 `--dry-run`。
