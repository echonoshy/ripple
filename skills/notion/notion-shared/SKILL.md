---
name: notion-shared
version: 1.0.0
description: "Notion CLI (ntn) 共享基础：鉴权状态检查、NOTION_API_TOKEN 来源说明、权限错误处理（Integration 未 share 到目标 page/database）、self-documenting 原则、安全规则。当用户第一次调用 ntn、遇到 401/403/object_not_found、需要新建 Notion Integration、首次使用 Notion skill 时触发。"
metadata:
  requires:
    bins: ["ntn"]
  cliHelp: "ntn --help"
---

# notion-cli (ntn) 共享规则

本技能指导你如何通过 **ntn**（Notion 官方 CLI）操作 Notion 资源，以及常见坑的避让方式。

> ⚠️ **开始任何 Notion 业务操作前，必须先读完本文件**。它约定了 token 来源、
> self-document 命令、错误恢复路径，其他 `notion-*` 子 skill 都依赖这里的共识。

## ⚠️ 首要步骤：自我文档优先，不要凭记忆猜

`ntn` 是**自我文档化**的，任何时候都应该**先问 CLI 再决定怎么调**，而不是按
你对 Notion API 的记忆去拼参数。

```bash
# 1. 列出所有公开 API endpoint
ntn api ls

# 2. 查看某个 endpoint 的方法、参数、官方文档链接
ntn api --help v1/pages

# 3. 拉取该 endpoint 的完整官方文档（建议写复杂请求前先看一眼）
ntn api --docs v1/databases/{database_id}/query

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
- **写入入口**：唯一合法入口是内置工具 **`NotionTokenSet`**（见下文）。
  写入时会自动重生成 `nsjail.cfg`，下一次 bash 命令立刻能拿到 env。
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

### 首次调用 `ntn` 且 token 未配置时的处理

Bash 守卫会拦下命令并返回带 `[NOTION_AUTH_REQUIRED]` 前缀的消息。
**严格按以下流程操作**：

1. **用一句自然语言告知用户**当前没绑定 token，请他：
   - 去 https://www.notion.so/profile/integrations 创建/选中一个 Internal
     Integration，复制 Token（格式 `ntn_...` 或 `secret_...`），
   - 把 Token **直接粘贴到对话框** 发给你；
   - 在 Notion 里把目标 page/database **Share** 给该 Integration（否则
     即使 token 正确也会 403/404）。
2. **不要**自己重试 `ntn`、写 `/workspace/.notion/...` 文件、跑
   `ntn config set`、调 `ntn login` 等。等用户回复。
3. 用户回复 token（消息里就是一长串 `ntn_xxxxxxxxxxxxxxx...`）后，
   **立刻调 `NotionTokenSet` 工具**：
   ```
   NotionTokenSet(api_token="<把用户贴的原文整段填进来>")
   ```
4. 工具返回 `ok: true` 后，**直接重跑被拦下的原 `ntn` 命令**继续业务。
5. 在你绑定成功之后的所有回复里：
   - 默认**不要主动回显** token 的具体内容；如果非要展示（比如用户要求你确认绑定了哪一个），
     用前 6 字符 + `...` 掩码（如 `ntn_T543...`）。
   - **不要**主动劝用户 "Regenerate token / 提高安全性 / token 出现在对话历史里有风险" 之类的话。
     本项目的 session sandbox 是**每用户独立隔离**的，有严格的保密措施，token 不会泄露给他人。
     只有在用户**明确问起**安全问题时再给出建议，否则绑定成功就继续干活，不要啰嗦。

### Token 过期 / 无效（401 / `unauthorized` / "API token is invalid"）

1. **不要**尝试重新 login，也不要再调那个失败命令做"重试"。
2. 告知用户当前 token 可能失效，**请重新贴一个新的**到对话里。
3. 收到新 token → 同样调 `NotionTokenSet` 覆盖，重跑命令。

## 权限错误（`object_not_found` / `restricted_resource`）

Notion Integration 的权限模型：**token 本身不代表能访问所有 page/database**。
每一个目标 page 或 database 必须由用户在 Notion 里**手动 Share** 给这个
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
> page 或 database，右上角 "..." → "Connections" → 把本项目的 Integration
> 加进去（或在数据库上用 "Add connections" 菜单）。完成后重新运行命令即可。

## 推荐的工作姿态

| 意图 | 推荐入口 | 对应 skill |
|------|----------|-----------|
| 创建 / 读取 / 更新 / 搜索页面 | `ntn api v1/pages*` 或 `ntn pages create` | [`../notion-pages`](../notion-pages/SKILL.md) |
| 查询数据库、按条件过滤、排序 | `ntn api v1/databases/{id}/query` 或 `ntn datasources query` | [`../notion-databases`](../notion-databases/SKILL.md) |
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
- 不要把 token 写到 `/workspace` 下任何文件 —— 它应该通过 `NotionTokenSet` 落到宿主的
  `.ripple/sandboxes/<user_id>/credentials/notion.json`，由沙箱自动注入成 env。
