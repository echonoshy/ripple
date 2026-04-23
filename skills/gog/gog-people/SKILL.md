---
name: gog-people
version: 1.0.0
description: "用 gog 读/写 Google Contacts（People API）。**先读 gog-shared**。create/update/delete/merge **必须先 AskUser 确认**。典型：从邮件签名抓联系人、按域名/公司筛客户、合并重复联系人。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-people

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 搜索（在姓名、email、phone、organization 里模糊搜）
gog --account <email> --json people search "Alice"
gog --account <email> --json people search "@example.com" --max 50

# 列所有 contacts（默认有分页，大库慎用）
gog --account <email> --json people list --max 100

# 单个 contact
gog --account <email> --json people get <resourceName>   # resourceName 形如 people/c1234567890

# 联系人分组
gog --account <email> --json people groups
gog --account <email> --json people group-members <groupId>

# "Other contacts"（自动收集，未被显式保存的）
gog --account <email> --json people other-list --max 100
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 创建
gog --account <email> people create \
  --name "Alice Chen" \
  --email alice@example.com \
  --phone "+86 13800000000" \
  --company "Example Inc" \
  --title "PM"

# 更新
gog --account <email> people update <resourceName> --email alice.new@example.com

# 删除
gog --account <email> people delete <resourceName>  # ⚠️

# 合并重复（两个 resourceName 合成一个）
gog --account <email> people merge <keepResourceName> <mergeFromResourceName>  # ⚠️⚠️

# 批量从 CSV 导入（字段：name,email,phone,company,title）
gog --account <email> people import --file ./contacts.csv --dry-run  # 先 dry-run
gog --account <email> people import --file ./contacts.csv           # ⚠️⚠️
```

## 典型场景

**场景：从最近 30 天邮件里抓没存过的联系人**
1. `gog gmail search 'newer_than:30d' --json` → 拿 from 字段
2. 去重 → 对每个 address `people search "<addr>"`
3. 筛出 0 结果的 address
4. AskUser 展示候选列表（约 N 个），让用户勾选要入库的
5. 循环 `people create`

**场景：找某公司的所有联系人**
```bash
gog --account <email> --json people search "@example.com" --max 200 \
  | jq '.results[] | {name: .person.names[0].displayName, email: .person.emailAddresses[0].value}'
```

**场景：合并重复**
1. `people list` 全量 → jq 按 email/phone group 找重复
2. AskUser 逐对确认保留哪个为主
3. `people merge` 执行

## 注意

- `resourceName` 格式是 `people/c<number>`；**不是 email**。
- `people update` 需要先拿 `etag`（CLI 一般自动带），并发更新会冲突。
- Other contacts 只能读不能写，要持久化得 `people create` 转成正式 contact。
