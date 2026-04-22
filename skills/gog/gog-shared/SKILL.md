---
name: gog-shared
version: 1.0.0
description: "gogcli（gog 二进制）在 ripple 沙箱中的本地约定：per-user 独立 GCP OAuth Client、三工具完成远程授权、破坏性操作走 AskUser 二次确认、self-document 原则、安全规则。**首次使用 gog 必读**。当用户第一次调用 gog、遇到 [GOGCLI_CLIENT_CONFIG_REQUIRED] / [GOGCLI_LOGIN_REQUIRED]、需要绑定/重新授权、或问到 gog 鉴权问题时触发。"
metadata:
  requires:
    bins: ["gog"]
  cliHelp: "gog --help"
---

# gog (Google Suite CLI) — ripple 沙箱本地约定

> ⚠️ **开始任何 gog 业务操作前必读本文件**。

## 🏗 整体鉴权模型（per-user 独立 GCP + 远程 2-step）

每个 ripple user 独立持有自己的 GCP 项目 / OAuth Client / refresh_token。跨 user 零共享。
**ripple server 和用户浏览器可以不在同一台机器**（与之前 gws 方案的核心区别）。

```
┌────────────────────────┐          ┌────────────────────────────┐
│ user 本机              │          │ ripple sandbox (per-user)  │
├────────────────────────┤          ├────────────────────────────┤
│ ① GCP Console 建       │          │ gog 二进制（预装）         │
│   Desktop OAuth Client │ ─json──▶ │ credentials/               │
│   下载 JSON            │          │   gogcli-client.json (600) │
│                        │          │                            │
│ ② 浏览器打开授权 URL    │ ◀─URL──  │ gog auth add --remote      │
│   点 Allow             │          │   --step 1 → 打印 URL      │
│                        │          │                            │
│ ③ 地址栏跳转报错没事     │ ──URL──▶ │ gog auth add --remote      │
│   复制完整 URL 贴回     │          │   --step 2 --auth-url ...  │
│                        │          │ 加密存 refresh_token 到    │
│                        │          │ /workspace/.config/gogcli/ │
└────────────────────────┘          └────────────────────────────┘
```

## ⚠️ 首要：self-document 优先，不要凭记忆猜

`gog` 是第三方 CLI，命令面和参数都是手写固定的。**先问 CLI 再拼参数**：

```bash
gog --help                         # 列 top-level 命令组
gog gmail --help                   # 列 gmail 下的子命令
gog gmail search --help            # 列 search 全部参数
gog <service> --help               # 每个 service 都有完整的 --help
```

不确定的地方先 `--help`，别硬拼。

## ✅ 首次使用 gog 的标准流程（3 步 + 1 次点击）

### 步骤 1：用户在 GCP Console 建 Desktop OAuth Client（**只做一次**）

当你第一次遇到 `[GOGCLI_CLIENT_CONFIG_REQUIRED]`，用一段自然语言引导用户：

1. 打开 <https://console.cloud.google.com/apis/credentials>，选项目（没有就新建）。
2. `Create Credentials` → `OAuth client ID` → Application type: **Desktop app** → 给个名字（如 `ripple-gog`）→ Create。
3. 弹窗里点 `Download JSON`。文件名形如 `client_secret_<number>-<hash>.apps.googleusercontent.com.json`。
4. 配置 OAuth consent screen：
   - User type `Internal`（Workspace 组织账号）：组织内用户开箱即用。
   - User type `External`（个人 gmail 账号）：把要登录的 Google 账号加入 **Test users** 列表。
5. `Enabled APIs & Services` 里**一次性**启用下面全部 API（因为我们这次就全量授权，不再二次来回）：
   Gmail / Drive / Calendar / Docs / Sheets / Slides / Tasks / People / Chat / Forms / Apps Script / Classroom。
6. **把下载的 JSON 文件全部内容** 粘贴进对话。

### 步骤 2：agent 调 `GoogleWorkspaceClientConfigSet`

用户贴出 JSON 后**立刻**调：

```
GoogleWorkspaceClientConfigSet(client_secret_json="<用户贴的原文>")
```

回复里**可以**提 `client_id`，**不要**回显完整 `client_secret`。

### 步骤 3：agent 调 `GoogleWorkspaceLoginStart`

```
GoogleWorkspaceLoginStart(email="user@gmail.com")
```

工具返回 `{ok: true, oauth_url: "https://accounts.google.com/o/oauth2/...", email, expires_in_seconds: 600}`。

### 步骤 4：把 URL **完整原样**给用户

```
请在你本机浏览器打开以下 URL 授权（ripple server 和你浏览器不在同一台机器也没关系）：

https://accounts.google.com/o/oauth2/auth?...<完整 URL>...

1. 用要绑定的 Google 账户登录
2. 审查申请的权限，点 "Allow / 允许"
3. 浏览器会跳转到 http://127.0.0.1:<端口>/oauth2/callback?code=...&state=...
   页面会显示"无法连接"——这是正常的，因为你本机上没 server
4. **从浏览器地址栏把完整 URL 复制下来**贴回对话里告诉我
```

**不要**：
- 缩短 / 省略 URL 的任何字符（一个参数错了就授权失败）
- 帮用户 decode URL / 把参数"解读一遍"（没用、可能误导）
- 主动说"这个 URL 有风险"（sandbox 隔离，授权本来就是这么工作的）

### 步骤 5：用户粘回 callback URL 后，agent 调 `GoogleWorkspaceLoginComplete`

```
GoogleWorkspaceLoginComplete(email="user@gmail.com", callback_url="<用户粘贴的完整 URL>")
```

工具内部跑 step 2，把 code 换 token，加密存 refresh_token。成功后业务命令就能用了。

## ❌ 授权失败 / 超时怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| step 2 报 "state expired" / "state mismatch" | 用户点 Allow 距 step 1 > 10 分钟 | 重跑 `GoogleWorkspaceLoginStart` 拿新 URL |
| step 2 报 "access_denied" | External+Testing、用户没在 Test users | 让用户去 consent screen 把自己加进 Test users |
| step 2 报 "redirect_uri_mismatch" | OAuth Client 不是 Desktop 类型 | 重新建一个 **Desktop** 类型的 OAuth Client |
| `gog auth status` 后来报 invalid_grant / refresh_token 失效 | token 被 revoke / 项目变更 | 重跑 `GoogleWorkspaceLoginStart` + `Complete` |
| Login 工具返回 "没抓到 URL" | client_id/secret 无效；gog 启动异常 | 让用户重发 client_secret.json + 重新 `ClientConfigSet` |

## ⚠️ API 未启用（403 `accessNotConfigured`）

运行业务命令时如果报这个，响应里会含 `enable_url`：

```
{"error": {"code": 403, "reason": "accessNotConfigured",
 "enable_url": "https://console.developers.google.com/apis/api/gmail.googleapis.com/..."}}
```

把 `enable_url` 给用户，让他去 GCP Console 点 **Enable**；等 ~10 秒生效再重试。**不要**反复自动重试。

## 🛡 破坏性操作必须调 AskUser 二次确认（ripple 纪律）

以下 gog 子命令**执行前必须**先调 `AskUser(question=...)` 工具、等用户明确同意后再调 `Bash` 执行。**绝不能直接执行**。

**破坏性命令清单**（见一个就必须停）：

| Service | 命令 |
|---|---|
| gmail | `send` / `drafts send` / `forward` / `reply` / `delete` / `batch delete` / `filters delete` / `labels delete` / `labels modify --remove` |
| drive | `delete` / `unshare` / `share` / `move`（不确定目标时）/ `upload --replace` |
| sheets | `delete-tab` / `clear` / `update`（覆盖已有数据）/ `chart delete` |
| docs | `sed`（修改文档）/ `write --replace` / `find-replace` |
| calendar | `delete` / `update` / `respond` |
| contacts | `delete` / `update`（覆盖字段时） |
| tasks | `delete` / `clear` / `done` / `undo` |
| classroom | `courses delete` / `courses archive` |
| admin | **所有 admin.* 操作**（groups members add/remove、users suspend、etc） |

`AskUser` 调用形态：

```
AskUser(
    question="准备执行：`gog --account alice@gmail.com gmail send --to bob@example.com --subject 'Weekly update' --body-file ./summary.md`\n这会把 summary.md 作为邮件正文发给 bob@example.com。确认吗？",
    options=["yes, send it", "no, cancel", "let me review the body first"]
)
```

**复述原则**：把**完整 shell 命令** + **影响范围（发给谁 / 删什么 / 覆盖哪个 range）** 一起给用户看。不要只说"确认发邮件吗"这种模糊问法。

**`--dry-run` 优先**：支持 `--dry-run` 的命令（很多写操作都有）先跑 dry-run 看 gog 打印的 request 体，再让用户 AskUser 确认真跑。

**批量操作**（循环超过 5 次 / 影响超过 5 项）前必须先把完整计划列给用户过目，不能闷头跑完。

## 🎨 Agent-friendly 输出惯例

- **优先 `--json`**：脚本化 / 程序化处理都用 `--json`，不要 pipe 表格输出去 grep 列。
- **`--plain`（TSV）** 也可，列对齐稳定。
- **stderr vs stdout 分离**：数据走 stdout，进度 / 提示走 stderr，可以干净地 `| jq ...`。
- **时区便利字段**：Calendar 的 JSON 输出包含 `startDayOfWeek` / `endDayOfWeek` / `timezone` / `startLocal` / `endLocal`，用起来很顺手。
- **`gog time now`**：要对齐当前时间 / 时区时用它，不要自己猜时间。

## 🛠 常用工作入口

| 意图 | 入口 | 典型子命令 |
|---|---|---|
| 搜邮件 / 读 thread | `gog gmail` | `search` / `thread get` / `get` |
| 发邮件 | `gog gmail send`（⚠️ 破坏性） | `send` / `forward` / `drafts create` |
| 看日程 | `gog calendar` | `events` / `event` / `search` |
| 创建 / 改日程（⚠️ 破坏性） | `gog calendar create/update/delete` | |
| 列 / 搜 / 上传 Drive | `gog drive` | `ls` / `search` / `upload` |
| 删 / share Drive（⚠️ 破坏性） | `gog drive delete/share/unshare` | |
| 读 Sheet | `gog sheets get` / `metadata` | |
| 写 Sheet（⚠️ 破坏性） | `gog sheets update/append/clear` | |
| 读 Doc | `gog docs info/cat/list-tabs` | |
| 写 Doc（⚠️ 破坏性） | `gog docs update/write/sed/find-replace` | |
| 列 Tasks | `gog tasks lists/list/get` | |
| 修改 Tasks（⚠️ 破坏性） | `gog tasks add/update/done/delete` | |
| 其他：people / chat / forms / classroom / appscript | `gog <service> --help` | self-document |

## 🧭 账号选择

每条命令都用 `--account <email>` 显式指定账号，或全局 `GOG_ACCOUNT=<email>`。不要依赖 `auto`（对多账号场景可能选错）。

```bash
gog --account alice@gmail.com gmail search 'newer_than:7d'
```

## 🔒 安全规则（操作纪律，不反复唠叨用户）

**前提：ripple sandbox 严格 per-user 隔离，credentials 不会泄露给其他用户。** 下列是**你自己要守的纪律**，不是反复劝用户的理由。

- 默认不回显 `client_secret` / 加密 credentials。用户明确问起时只说"已绑定，账号 xxx@y.com"或展示 `client_id`（它不是 secret）。
- **不要**主动建议 "rotate client_secret" / "credentials 出现在对话历史有风险"。只有用户自己问或明显有泄漏事件才提。
- **写 / 删操作必须走 AskUser**（见上面）—— 这条没有例外。
- **批量操作**先列计划 → AskUser → 再跑。
- 不要往 `/workspace` 下手写任何 credentials 文件；该落的位置（`/workspace/.config/gogcli/`）由 gog 自己管。
- `--dry-run` 是写操作的好朋友。
