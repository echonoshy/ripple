---
name: gog-tasks
version: 1.0.0
description: "用 gog 读/写 Google Tasks（个人待办）。**先读 gog-shared**。对 add/update/done/delete/clear **必须先 AskUser 确认**。典型：今日 / 本周待办、从邮件/日程批量导入 task、完成/归档。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-tasks

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`（鉴权 + 写操作 AskUser 纪律）。

## 只读（无需确认）

```bash
# 列所有 task list
gog --account <email> --json tasks lists

# 列 default list 下的 tasks
gog --account <email> --json tasks list

# 列指定 list
gog --account <email> --json tasks list --list <listId> --max 50

# 只看未完成
gog --account <email> --json tasks list --show-completed=false

# 单个 task 详情
gog --account <email> --json tasks get <listId> <taskId>
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建 task
gog --account <email> tasks add "Write Q2 report" --list <listId> --due 2026-05-01
gog --account <email> tasks add "Call Alice" --notes "re: project kickoff" --due 2026-04-25

# 更新
gog --account <email> tasks update <listId> <taskId> --title "new title" --due 2026-05-02

# 完成
gog --account <email> tasks done <listId> <taskId>  # ⚠️ 建议 AskUser

# 撤销完成
gog --account <email> tasks undo <listId> <taskId>  # ⚠️

# 删除
gog --account <email> tasks delete <listId> <taskId>  # ⚠️

# 清空某 list 的已完成项
gog --account <email> tasks clear <listId>  # ⚠️⚠️

# 新建 list
gog --account <email> tasks lists create "Work"
```

## 典型场景

**场景：把近 7 天 inbox 里的 action item 全部扔进 Tasks**
1. `gog gmail search 'in:inbox newer_than:7d "action required"'` → 拿 thread 列表
2. 给用户看列表（subject + from）
3. AskUser 批确认要创建 N 条 task
4. 循环 `tasks add "..." --notes "<mail link>"` —— 每次对新 task 一条，整批跑前先把完整计划列给用户过目

**场景：今日 todo**
```bash
gog --account <email> --json tasks list --show-completed=false \
  | jq '.tasks[] | select(.due < "tomorrow")'
```

## 注意

- Google Tasks 原生支持 subtask（parent/child）但 CLI 的支持度看 `gog tasks add --help` 的 `--parent` 参数。
- `--due` 用 `YYYY-MM-DD`（Google Tasks 不支持小时级 due），相对时间先用 `gog time now` 对齐。
- Tasks list 数量通常很少（< 10），不用操心分页。
