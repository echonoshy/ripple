---
name: gog-gmail
version: 1.0.0
description: "用 gog 读/搜/发 Gmail。**先读 gog-shared**（鉴权 + AskUser 纪律）。对 send/delete/forward/reply/batch delete/filters 等写操作**必须先 AskUser 确认**。典型场景：收件箱三分钟 triage、搜近 7 天带附件邮件、回复特定 thread、创建 draft、批量 archive。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-gmail

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`（鉴权 + 写操作 AskUser 纪律）。

## 常用只读命令（无需确认）

```bash
# 搜索 thread
gog --account <email> --json gmail search 'newer_than:7d has:attachment' --max 20

# 读 thread 详情
gog --account <email> --json gmail thread get <threadId>

# 读 message
gog --account <email> --json gmail get <messageId>
gog --account <email> --json gmail get <messageId> --format metadata  # 只拿 header

# 列 labels
gog --account <email> --json gmail labels list
gog --account <email> --json gmail labels get INBOX  # 含消息数

# Message-level 搜索（一条邮件一行）
gog --account <email> --json gmail messages search 'newer_than:7d' --max 10 --full
```

## 写操作（⚠️ 必须先 AskUser 确认）

```bash
# 发邮件 —— 先 AskUser 把完整命令、收件人、正文摘要给用户看
gog --account <email> gmail send --to a@b.com --subject "Hi" --body-file ./message.txt

# 发 HTML 邮件（--body 作为 plain fallback）
gog --account <email> gmail send --to a@b.com --subject "Hi" --body "Plain" --body-html "<p>Hello</p>"

# 转发
gog --account <email> gmail forward <messageId> --to a@b.com --note "FYI"

# 回复（要先 AskUser 确认 quote 的原文内容）
gog --account <email> gmail send --reply-to-message-id <messageId> --quote \
  --to <original_from> --subject "Re: ..." --body "My reply"

# Draft 创建/修改/发送
gog --account <email> gmail drafts create --subject "..." --body "..."
gog --account <email> gmail drafts send <draftId>  # ⚠️ 确认后才能调

# Label 修改（--add 通常 SAFE；--remove INBOX 等相当于 archive，AskUser 建议）
gog --account <email> gmail thread modify <threadId> --add STARRED --remove INBOX

# 批量删除 / archive（必须 AskUser + 先 --json 列出 thread 数）
gog --account <email> gmail batch delete <id> <id> <id>  # ⚠️
```

## 典型场景

**场景：三分钟 inbox triage**
1. `gog --json gmail search 'in:inbox newer_than:3d' --max 50`
2. 按 from / subject 分类，输出一份摘要给用户
3. 根据用户指示，逐 thread `gog gmail thread modify --remove INBOX --add <Label>`（每个写操作一次 AskUser 或一次批量 AskUser 后批跑）

**场景：回复某个发件人最近一封邮件**
1. `gog --json gmail search 'from:alice@x.com' --max 1 --full` → 拿到 threadId 和正文
2. AskUser 把要回复的内容（复述 + 原邮件摘要）给用户确认
3. `gog gmail send --reply-to-message-id <id> --quote --to alice@x.com --subject "Re: ..." --body-file /tmp/reply.txt`

**场景：导出 filters**

```bash
gog --account <email> gmail filters export --out /workspace/gmail-filters-backup.json
```

## 注意

- `--track`（email tracking）**不做**，和 ripple 无关。
- 复杂 Gmail search 语法（`has:drive`, `label:Foo-Bar`, `older_than:...`）看 [Gmail Search operators](https://support.google.com/mail/answer/7190)。
- `gmail watch`（Pub/Sub push）**MVP 不启用**，需要时单独设计。
