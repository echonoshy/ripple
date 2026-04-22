---
name: gog-calendar
version: 1.0.0
description: "用 gog 读/搜/创建/改 Calendar 事件。**先读 gog-shared**。对 create/update/delete/respond 写操作**必须先 AskUser 确认**。典型：今日日程、本周会议冲突、创建带 attendee 的会议。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-calendar

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读（无需确认）

```bash
# 今日 / 本周
gog --account <email> --json calendar events <calId> --today
gog --account <email> --json calendar events <calId> --week
gog --account <email> --json calendar events <calId> --days 3

# 列日历本身
gog --account <email> --json calendar calendars

# 某单个事件
gog --account <email> --json calendar event <calId> <eventId>

# 搜索
gog --account <email> --json calendar search "meeting" --days 30 --max 50

# Free/busy
gog --account <email> --json calendar freebusy \
  --calendars "primary,colleague@x.com" \
  --from 2026-04-22T00:00:00Z --to 2026-04-23T00:00:00Z

# 冲突检测
gog --account <email> --json calendar conflicts --all --today
```

JSON 里的 `startDayOfWeek` / `timezone` / `startLocal` / `endLocal` 直接用，不要自己算。

## 写操作（⚠️ 必须先 AskUser）

```bash
# 创建事件
gog --account <email> calendar create primary \
  --summary "Team Sync" \
  --from 2026-04-25T10:00:00Z \
  --to 2026-04-25T11:00:00Z \
  --attendees "alice@x.com,bob@x.com" \
  --location "Zoom"

# 默认 **不发** attendee 邮件通知，显式加 --send-updates all 才发（发前 AskUser）
gog --account <email> calendar create ... --send-updates all  # ⚠️

# 更新（AskUser 复述 diff）
gog --account <email> calendar update <calId> <eventId> --summary "New" --from ...

# 删除
gog --account <email> calendar delete <calId> <eventId> --send-updates all --force  # ⚠️

# 回复邀请
gog --account <email> calendar respond <calId> <eventId> --status accepted  # ⚠️ 建议 AskUser
```

## 典型场景

**场景：今日日程 + 冲突**
```bash
gog --account <email> --json calendar events primary --today \
  | jq '.events[] | {summary, startLocal, endLocal}'
gog --account <email> --json calendar conflicts --all --today
```

**场景：协调 3 人会议**
1. 拿所有人 freebusy
2. 找一个 30 分钟空档
3. AskUser 确认时间 + 主题 + 是否发通知
4. `calendar create` 用 `--send-updates all`

## 注意

- 时间优先用 RFC3339 (`2026-04-22T10:00:00Z` 或 `...-08:00`)，不容易搞错时区。
- 提到 "tomorrow" / "明天" 这种相对时间，先 `gog time now` 拿当前时间再算。
