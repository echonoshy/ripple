---
name: lark-skill-maker
version: 1.0.0
description: "创建 lark-cli 的自定义 Skill。当用户需要把飞书 API 操作封装成可复用的 Skill（包装原子 API 或编排多步流程）时使用。"
metadata:
  requires:
    bins: ["lark-cli"]
---

# Skill Maker

基于 lark-cli 创建新 Skill。Skill = 一份 `SKILL.md`，教 AI 用 CLI 命令完成任务。

## CLI 核心能力

```bash
lark-cli <service> <resource> <method>          # 已注册 API
lark-cli <service> +<verb>                      # Shortcut（高级封装）
lark-cli api <METHOD> <path> [--data/--params]  # 任意飞书 OpenAPI
lark-cli schema <service.resource.method>       # 查参数定义
```

优先级：Shortcut > 已注册 API > `api` 裸调。

## 调研 API

```bash
# 1. 查看已有的 API 资源和 Shortcut
lark-cli <service> --help

# 2. 查参数定义
lark-cli schema <service.resource.method>

# 3. 未注册的 API，用 api 直接调用
lark-cli api GET /open-apis/vc/v1/rooms --params '{"page_size":"50"}'
lark-cli api POST /open-apis/vc/v1/rooms/search --data '{"query":"5F"}'
```

如果以上命令无法覆盖需求（CLI 没有对应的已注册 API 或 Shortcut），使用 [lark-openapi-explorer](../lark-openapi-explorer/SKILL.md) 从飞书官方文档库逐层挖掘原生 OpenAPI 接口，获取完整的方法、路径、参数和权限信息，再通过 `lark-cli api` 裸调完成任务。

通过以上流程确定需要哪些 API、参数和 scope。

## SKILL.md 模板

文件放在 `skills/lark-<name>/SKILL.md`：

```markdown
---
name: lark-<name>
version: 1.0.0
description: "<功能描述>。当用户需要<触发场景>时使用。"
metadata:
  requires:
    bins: ["lark-cli"]
---


# <标题>

> **前置条件：** 先阅读 [`../lark-shared/SKILL.md`](../lark-shared/SKILL.md)。
>
> 默认按 `lark-shared` 的全局默认执行：所有命令显式带 `--as user`；如果未登录，
> 走两段式 `lark-cli auth login --no-wait --json --domain all`（一次性全域授权）。
> **不要**在本 skill 里另写 `--domain xxx` 之类的窄域示例。

## 命令

\```bash
# 单步操作（注意显式 --as user）
lark-cli api POST /open-apis/xxx --as user --data '{...}'

# 多步编排：说明步骤间数据传递
# Step 1: ...（记录返回的 xxx_id）
# Step 2: 使用 Step 1 的 xxx_id
\```

## 权限

| 操作 | 所需 scope |
|------|-----------|
| xxx | `scope:name` |

> 列 scope 表只是给"`--domain all` 之后仍报 `missing_scope`"或"用户明确要求收窄"
> 的兜底场景做参考。**不要**因此在示例命令里写窄域 `--domain ...`。
```

## 关键原则

- **description 决定触发** — 包含功能关键词 + "当用户需要...时使用"
- **身份默认** — 所有可同时支持 user/bot 的 API，示例命令必须显式带 `--as user`；
  仅当目标 API 只支持 bot 或用户明确要求"以应用身份"时，才写 `--as bot` 并标注理由
- **认证默认** — 说明所需 scope 仅供兜底参考；**示例登录命令必须写
  `lark-cli auth login --no-wait --json --domain all`**，不要按业务域收窄
- **安全** — 写入操作前确认用户意图，建议 `--dry-run` 预览
- **编排** — 说明数据传递、失败回滚、可并行步骤
