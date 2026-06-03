---
name: gog-shared
version: 1.2.0
description: "gogcli（gog 二进制）在 ripple 沙箱中的本地约定：部署级 Google OAuth Client 自动注册、用户级 refresh_token 隔离、仅授权基础 Workspace 服务（Gmail/Drive/Calendar/Docs/Sheets/Slides）、assisted/manual 远程授权、破坏性操作走自然语言二次确认、self-document 原则、安全规则。**首次使用 gog 必读**。适用于第一次调用 gog、遇到 [GOGCLI_SERVER_OAUTH_CLIENT_REQUIRED] / [GOGCLI_LOGIN_REQUIRED]、需要绑定/重新授权、或用户询问 gog 鉴权问题的场景。"
metadata:
  requires:
    bins: ["gog"]
    connectors: ["google_workspace"]
  cliHelp: "gog --help"
---

# gog (Google Suite CLI) — ripple 沙箱本地约定

> ⚠️ **开始任何 gog 业务操作前必读本文件**。

## 🏗 整体鉴权模型（部署级 OAuth Client + user 级 token）

默认模式：部署方在 `config/settings.yaml` 里配置一次 Google OAuth Client；每个 ripple user 只持有自己的 refresh_token。跨 user 的账号授权、workspace、keyring 仍然零共享。
**最终用户只需要打开授权 URL 点 Allow；所有 Google 开发者项目配置由服务端管理员完成。**
**ripple server 和用户浏览器可以不在同一台机器**。
当前只授权基础 Workspace 服务：Gmail、Drive、Calendar、Docs、Sheets、Slides。

```
┌────────────────────────┐          ┌────────────────────────────┐
│ user 本机              │          │ ripple sandbox (per-user)  │
├────────────────────────┤          ├────────────────────────────┤
│ ① 浏览器打开授权 URL    │ ◀─URL──  │ gog 二进制（预装）         │
│   点 Allow             │          │ credentials/               │
│                        │          │   gogcli-client.json (600) │
│                        │          │   ↑ 从部署级配置自动注册   │
│                        │          │                            │
│ ② Google callback      │ ───────▶ │ Ripple callback 自动完成   │
│   显示授权完成          │          │   step 2 --auth-url ...    │
│                        │          │                            │
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

## ✅ 首次使用 gog 的标准流程（控制面发起 + 1 次点击）

### 步骤 1：Ripple 控制面发起 Google OAuth

默认部署应已在 `config/settings.yaml` 配好 `server.gogcli_oauth.client` 和 `server.gogcli_oauth.callback_url`。当前 user 第一次使用 Google Workspace 能力时，Ripple 控制面会自动把部署级 OAuth Client 注册到该 user 的 gogcli 配置里，然后直接返回 Google 授权 URL。

不要先问用户 Google 邮箱。用户会在 Google 授权页面自己选择要绑定的账号；Ripple callback 会读取 Google 返回的真实账号邮箱，并用 gogcli 的 token import 流程保存 refresh token。

### 步骤 2：把 URL **完整原样**给用户

```
请在浏览器打开以下 URL 授权：

https://accounts.google.com/o/oauth2/auth?...<完整 URL>...

1. 在 Google 页面选择要绑定的账户
2. 审查申请的权限，点 "Allow / 允许"
3. 浏览器显示 Ripple 授权完成后，可以关闭授权页
```

**不要让用户复制地址栏 callback URL**；Ripple 后端会自动接收 Google callback、换 token、保存到当前 user 的 gogcli keyring，并恢复刚才的任务。

**不要**：
- 缩短 / 省略 URL 的任何字符（一个参数错了就授权失败）
- 帮用户 decode URL / 把参数"解读一遍"（没用、可能误导）
- 主动说"这个 URL 有风险"（sandbox 隔离，授权本来就是这么工作的）
- 要求用户先输入 Google 邮箱地址
- 要求用户授权完成后回"好了"

### 步骤 3：完成授权

控制面轮询发现授权完成后，会自动恢复原始用户请求。业务命令里再用 `gog --account <email> ...`；如果用户没有指定账号，先用 `gog auth list --json` 查看当前 user 已绑定账号。

### 服务端未配置 OAuth Client 时的处理

如果 Ripple 控制面返回 `[GOGCLI_SERVER_OAUTH_CLIENT_REQUIRED]`，说明部署级 Google OAuth 还没配置完成。

这不是终端用户能解决的问题。回复用户时只说：

```
Google Workspace 授权还没有在服务端配置完成。请管理员配置后，我再帮你发起授权。
```

然后停止 gog 授权流程，等待管理员修复 `config/settings.yaml` 里的 `server.gogcli_oauth.client`，并把实际 callback URL 加入 Google Web 授权应用的 Authorized redirect URIs。通常 callback URL 是：

```
<server.public_base_url>/v1/sandboxes/gogcli/oauth/callback
```

**不要**要求终端用户提供任何 Google 开发者项目配置或凭据 JSON。部署级 OAuth Client 只由管理员在配置文件里维护，不属于正常用户路径。

## ❌ 授权失败 / 超时怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| step 2 报 "state expired" / "state mismatch" | 用户点 Allow 距 step 1 > 10 分钟 | 让 Ripple 控制面重新发起授权并给出新 URL |
| step 2 报 "access_denied" | External+Testing、账号不在 Test users 或用户拒绝授权 | 让管理员检查 OAuth consent screen/Test users；如果是用户主动拒绝，重新发起授权 |
| step 2 报 "redirect_uri_mismatch" | 部署级 OAuth Client 的 Authorized redirect URI 与当前 Ripple callback URL 不匹配 | 让管理员把实际 callback URL 加入 Google OAuth Client；通常是 `<server.public_base_url>/v1/sandboxes/gogcli/oauth/callback` |
| `gog auth status` 后来报 invalid_grant / refresh_token 失效 | token 被 revoke / 项目变更 | 让 Ripple 控制面重新发起授权 |
| 授权启动流程返回 "没抓到 URL" | 服务端 OAuth client 配置无效；gog 启动异常 | 让管理员检查 `server.gogcli_oauth.client` 和 gogcli 安装 |

## ⚠️ API 未启用（403 `accessNotConfigured`）

运行业务命令时如果报这个，响应里会含 `enable_url`：

```
{"error": {"code": 403, "reason": "accessNotConfigured",
 "enable_url": "https://console.developers.google.com/apis/api/gmail.googleapis.com/..."}}
```

这是服务端 Google 项目配置问题。告诉用户"服务端 Google API 还没启用，请管理员处理"，把 `enable_url` 留给管理员排查；不要要求终端用户处理 Google 项目配置。等管理员启用后再重试，**不要**反复自动重试。

## 🔍 运行时检查 & 账号管理

当前控制面负责发起 OAuth 和保存 token；业务执行阶段只需要查看账号、选择 `--account`，以及在用户明确要求时解绑：

- **账号状态检查**（只读，SAFE）
  - 用 `gog auth list --json` 查看当前 user 绑了哪些邮箱、alias 是什么。
  - 开局不确定该用哪个 `--account` 的时候先查账号列表。
  - 业务命令报 `invalid_grant` / `unauthorized_client` 时，停止当前业务命令，让 Ripple 控制面重新发起 Google 授权。

- **账号解绑**（⚠️ 破坏性，见下面破坏性清单）
  - 解绑由 Ripple connector disconnect/account 管理流程处理，不在业务执行里自行删除 keyring。
  - **不**撤销 Google 侧的授权；如果用户要彻底 revoke，引导去 <https://myaccount.google.com/permissions>。
  - 不动 Desktop OAuth client config（跨账号共享）。

## 🧰 gogcli 授权/账号入口

| 用途 | 工具 | 何时调 |
|---|---|---|
| OAuth 授权 | Ripple 控制面 connector auth | 每次新账号 / refresh token 失效；不要在业务执行里问邮箱或吃 callback URL |
| 列已绑账号 | `gog auth list --json` | 开局、可疑 token 错误 |
| 解绑账号 | Ripple connector disconnect/account 管理流程 | 用户明确要求解绑（⚠️ 先确认） |

## 🛡 破坏性操作必须二次确认（ripple 纪律）

以下 gog 子命令**执行前必须**先向用户输出确认问题并停止。等用户下一轮明确同意后，才能继续执行。**绝不能直接执行**。

**破坏性命令清单**（见一个就必须停）：

| Service | 命令 |
|---|---|
| gogcli（工具层） | Ripple connector disconnect/account 解绑流程（会移除该账号的 refresh_token） |
| gmail | `send` / `drafts send` / `forward` / `reply` / `delete` / `batch delete` / `filters delete` / `labels delete` / `labels modify --remove` |
| drive | `delete` / `unshare` / `share` / `move`（不确定目标时）/ `upload --replace` |
| sheets | `delete-tab` / `clear` / `update`（覆盖已有数据）/ `chart delete` |
| docs | `sed`（修改文档）/ `write --replace` / `find-replace` |
| calendar | `delete` / `update` / `respond` |

确认问题形态：

```
准备执行：`gog --account alice@gmail.com gmail send --to bob@example.com --subject 'Weekly update' --body-file ./summary.md`
这会把 summary.md 作为邮件正文发给 bob@example.com。请明确回复是否确认发送，或要求我先展示正文。
```

**复述原则**：把**完整 shell 命令** + **影响范围（发给谁 / 删什么 / 覆盖哪个 range）** 一起给用户看。不要只说"确认发邮件吗"这种模糊问法。

**`--dry-run` 优先**：支持 `--dry-run` 的命令（很多写操作都有）先跑 dry-run 看 gog 打印的 request 体，再让用户确认真跑。

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
| Slides 读 / 导出 | `gog slides info/slide/export` | 见 `gog-slides` skill |
| Slides 写（⚠️ 破坏性） | `gog slides create/copy/find-replace/batch-update` | 见 `gog-slides` skill（优先 `--dry-run`） |

## 🧭 账号选择

每条命令都用 `--account <email>` 显式指定账号，或全局 `GOG_ACCOUNT=<email>`。不要依赖 `auto`（对多账号场景可能选错）。

```bash
gog --account alice@gmail.com gmail search 'newer_than:7d'
```

## 🔒 安全规则（操作纪律，不反复唠叨用户）

**前提：ripple sandbox 严格 per-user 隔离，credentials 不会泄露给其他用户。** 下列是**你自己要守的纪律**，不是反复劝用户的理由。

- 默认不回显 `client_secret` / 加密 credentials。用户明确问起时只说"已绑定，账号 xxx@y.com"或展示 `client_id`（它不是 secret）。
- **不要**主动建议 "rotate client_secret" / "credentials 出现在对话历史有风险"。只有用户自己问或明显有泄漏事件才提。
- **写 / 删操作必须走二次确认**（见上面）—— 这条没有例外。
- **批量操作**先列计划 → 用户明确确认 → 再跑。
- 不要往 `/workspace` 下手写任何 credentials 文件；该落的位置（`/workspace/.config/gogcli/`）由 gog 自己管。
- `--dry-run` 是写操作的好朋友。
