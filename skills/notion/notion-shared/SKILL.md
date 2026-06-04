---
name: notion-shared
version: 1.0.0
description: "Use when Notion work needs auth setup, first-time ntn access, token errors, Integration share errors, or shared Notion CLI safety rules."
metadata:
  requires:
    bins: ["ntn"]
  cliHelp: "ntn --help"
---

# notion-cli (ntn) 共享规则

本技能指导你如何通过 **ntn** 操作 Notion 资源，以及常见坑的避让方式。

> ⚠️ **开始任何 Notion 业务操作前，必须先读完本文件**。它约定了 token 来源、
> control-plane 鉴权、自我文档命令、错误恢复路径，其他 `notion-*` 子 skill 都依赖这里的共识。

## ⚠️ 首要步骤：自我文档优先，不要凭记忆猜

`ntn` 是**自我文档化**的，任何时候都应该**先问 CLI 再决定怎么调**，而不是按
你对 Notion API 的记忆去拼参数。

```bash
# 1. 列出所有公开 API endpoint
ntn api ls

# 2. 查看某个 endpoint 的方法、参数、官方文档链接
ntn api --help v1/pages

# 3. 拉取该 endpoint 的完整官方文档（建议写复杂请求前先看一眼）
ntn api --docs /v1/data_sources/{data_source_id}/query -X POST

# 4. 获取精简版 OpenAPI 片段（理解 request/response schema）
ntn api --spec v1/pages

# 5. 任何子命令都可以 --help
ntn --help
ntn files --help
ntn workers --help
```

**绝对不要**跳过这一步直接拼 `ntn api v1/xxx`，尤其是涉及嵌套参数（filters、sorts、
rich_text 结构）时 —— 凭记忆几乎一定会错。

## Token 来源（本项目强约定）

- **存储位置**：**per-user** 隔离。宿主侧文件
  `.ripple/sandboxes/<user_id>/credentials/notion.json`，仅当前 user 可读，不同 user 互不可见；同一 user 的多个 session 共享同一个 token。
- **写入入口**：唯一合法入口是 Ripple chat/control-plane token capture。用户把 token 粘到对话后，
  Ripple 会保存到当前 user credentials 并重生成 `nsjail.cfg`，下一次 bash 命令立刻能拿到 env。
- **沙箱注入方式**：沙箱启动时（生成 `nsjail.cfg` 的那一刻）读取
  `notion.json`，把 token 以环境变量 `NOTION_API_TOKEN` 注入沙箱。
  **没有全局单 token**，也不走 `config/settings.yaml`。
- **沙箱内表现**：`ntn` 会**自动**使用 `NOTION_API_TOKEN`，你**无需**调 `ntn login`。

所以你在沙箱里：

```bash
# ✅ 正确：直接调用，ntn 会读 env var
ntn api v1/users

# ❌ 错误：不要尝试 ntn login（需要浏览器，且本项目不走交互式登录）
ntn login
```

### 首次使用 Notion 且 token 未配置时的处理

Notion 授权是 **Ripple control-plane** 流程，不是在 Codex 里手写 token 文件，也不跑
`ntn login`。

如果 Connector Status 显示 `notion` 是 `not_connected`，你的最终回复必须**只输出下面这个裸标签**，
不要加代码块、解释文字或其他内容：

<ripple_connector_auth_request>{"connector":"notion","force_reauth":false,"reason":"needs Notion access"}</ripple_connector_auth_request>

随后 Ripple 会向用户展示 token 获取说明并捕获用户粘贴的 token。用户回复 token 后，
Ripple 会保存到当前 user credentials、刷新 nsjail 配置，并恢复刚才的请求。

恢复后：

1. **直接重跑原本需要执行的 Notion 业务命令**。
2. **不要**写 `/workspace/.notion/...` 文件、跑 `ntn config set`、调 `ntn login`，也不要把 token 存进 workspace。
3. 在你绑定成功之后的所有回复里：
   - 默认**不要主动回显** token 的具体内容；如果非要展示（比如用户要求你确认绑定了哪一个），
     用前 6 字符 + `...` 掩码（如 `ntn_T543...`）。
   - **不要**主动劝用户 "Regenerate token / 提高安全性 / token 出现在对话历史里有风险" 之类的话。
     本项目的 session sandbox 是**每用户独立隔离**的，有严格的保密措施，token 不会泄露给他人。
     只有在用户**明确问起**安全问题时再给出建议，否则绑定成功就继续干活，不要啰嗦。

### Token 过期 / 无效（401 / `unauthorized` / "API token is invalid"）

1. **不要**尝试重新 login，也不要把 token 写到 workspace。
2. 最终回复只输出下面这个裸标签，让 Ripple 重新进入 token capture：

<ripple_connector_auth_request>{"connector":"notion","force_reauth":true,"reason":"stored Notion token was rejected"}</ripple_connector_auth_request>

3. Ripple 保存新 token 后，重跑原命令。

## 权限错误（`object_not_found` / `restricted_resource`）

Notion Integration 的权限模型：**token 本身不代表能访问所有 page/database/data source**。
每一个目标 page、database 或 data source 必须由用户在 Notion 里**手动 Share** 给这个
Integration，token 才能读/写它。

### 识别

```json
{"object": "error", "status": 404, "code": "object_not_found",
 "message": "Could not find page with ID: xxxxxxxx..."}
```

或者：

```json
{"object": "error", "status": 403, "code": "restricted_resource"}
```

### 处理

**不要**反复重试请求，**不要**尝试换 endpoint 兜底。正确做法是停下来，告诉用户：

> 这个 page/database 还没有被 Share 给 Integration。请在 Notion 里打开目标
> page、database 或 data source，右上角 "..." → "Connections" → 把本项目的 Integration
> 加进去（或在数据库上用 "Add connections" 菜单）。完成后重新运行命令即可。

## 推荐的工作姿态

| 意图 | 推荐入口 | 对应 skill |
|------|----------|-----------|
| 创建 / 读取 / 更新 / 搜索页面 | `ntn api v1/pages*` 或 `ntn pages create` | [`../notion-pages`](../notion-pages/SKILL.md) |
| 查询数据库 / data source、按条件过滤、排序 | `ntn api v1/data_sources/{id}/query` 或 `ntn datasources query` | [`../notion-databases`](../notion-databases/SKILL.md) |
| 上传图片 / 文件到 Notion | `ntn files create` 等 | [`../notion-files`](../notion-files/SKILL.md) |
| 通用 API 调用（不确定走哪个） | `ntn api <path>` | [`../notion-cli`](../notion-cli/SKILL.md) |

## 安全规则

前提：本项目的 session sandbox **per-user 隔离**，有严格保密措施，token 不会泄露给其他用户。
所以下面这些是**操作纪律**，不是反复唠叨用户的理由 —— 不要主动把安全提示塞进每条回复里。

- 默认不主动打印完整 `NOTION_API_TOKEN`；用户明确要求展示时用前 6 字符 + `...` 掩码即可。
- **不要**主动建议用户 "Regenerate token / token 出现在对话历史有风险" 之类。只有用户自己
  问起安全问题、或者明显发生了泄漏事件时才提醒。
- **写入 / 删除操作**（创建 page、`archived=true`、覆盖属性等）执行前**必须**向
  用户复述意图并获得确认，除非用户在本轮对话里已经明确授权本次操作。
- 批量操作（循环里创建 >5 个 page）前先列出**完整计划**给用户过目，不要闷头跑完。
- 不要把 token 写到 `/workspace` 下任何文件 —— 它应该通过 Ripple control-plane token capture 落到宿主的
  `.ripple/sandboxes/<user_id>/credentials/notion.json`，由沙箱自动注入成 env。
