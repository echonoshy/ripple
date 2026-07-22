---
name: lark-shared
version: 1.3.1
description: "飞书/Lark CLI 共享基础：Ripple 对话授权、身份切换（--as user/bot）、权限与 scope 管理、Permission denied 错误处理、高风险操作确认和安全规则。适用于第一次配置、使用登录授权、遇到权限不足、切换 user/bot 身份、遇到 confirmation_required，或首次使用 lark-cli 的场景。"
metadata:
  requires:
    bins: ["lark-cli"]
    connectors: ["feishu"]
---

# lark-cli 共享规则

本技能指导你如何通过 lark-cli 操作飞书资源，以及有哪些注意事项。

## 运行环境前提（重要）

lark-cli 由 **Ripple 服务端受控执行**：每个调用都绑定当前 Ripple user，配置和 access
token 保存在服务端用户凭证目录，绝不位于 Agent workspace，也不会传给 Agent shell。

新版 lark-cli 在 Agent 环境里可能会提示使用绑定的 app。Ripple 正常路径是服务端统一
配置 Feishu app 后由 connector 注入；只有没有服务端 app、且确实要为当前 workspace
单独创建 app 时，才使用 `config init --new --force-init` 兜底。

## 全局默认（所有 lark-cli 操作都要遵守）

1. **调用入口：`codex_app.feishu_cli`** -- 不要在 shell 里运行 `lark-cli`。把命令中
   `lark-cli` 后的每个参数原样放入该动态工具的 `args` 数组，例如
   `lark-cli docs +create --title "周报"` 对应 `{"args":["docs","+create","--title","周报"]}`。
   服务端会使用当前用户隔离的凭证执行命令。
2. **身份默认：`--as user`** -- 凡是同时支持 `user` 与 `bot` 的 API，**必须显式
   带上 `--as user`**。CLI 底层默认是 `bot`，不显式指定会以应用身份发送/读取，
   行为与用户预期完全不同。
3. **授权只能走 Ripple 对话链路** -- Codex 不能直接执行 `lark-cli auth login`
   或手工生成授权 URL。用户授权、重新授权、补权限都由 Ripple control plane 在对话中处理。
4. 切换到 `--as bot` 仅限三种情况：
   - 用户在当前消息里**明确**要求"以应用 / bot 身份执行"；
   - 当前 API **只支持 bot**（如 `im.messages.forward`、`im.messages.merge_forward`、
     `im.images.create`、`im.chats.create` 等，子 skill 会标注 `Identity: bot only`）；
   - 当前工作流就是 bot 主动播报、在 bot 自己所在群里以应用身份发言。
5. 遇到 `need_user_authorization`、`missing_scope`、用户 token 缺失或授权状态不确定时，
   **停止业务命令**，请用户在对话里完成或重新完成 Feishu 授权；不要在 Codex shell 里补跑
   `auth login`。

子 skill 不需要重复声明这些默认；如果某个子 skill 与上面的默认相反（例如某个
API 只支持 bot），它会**显式覆盖**这条规则，否则一律按本节默认执行。

## 首要步骤：状态检查

`codex_app.feishu_cli` 在每条业务命令前自动检查当前用户的配置和认证状态；不要手工执行
`config show`、`auth status`、`whoami` 或 `doctor`。

根据返回结果判断：

1. 工具返回 `code="connector_auth_required"` -> 停止业务命令并走 Ripple 对话授权；不要生成或运行配置命令。
2. 工具成功 -> 直接使用返回的业务结果（仍然显式带 `--as user`）。

**绝对不要跳过这一步直接调用业务 API。**

## 配置初始化

app 凭证配置由 **Ripple control plane 自动处理**：

1. 用户在对话里提出 Feishu 相关请求时，Ripple 会先检查 connector 状态。
2. 如果 app 尚未配置，Ripple 会在 Codex 启动前返回 `[FEISHU_SETUP]` 配置链接。
3. 用户点击链接完成飞书应用创建后，Ripple 会继续进入用户授权步骤。
4. Codex 只在授权完成后执行业务命令。

**重要**：不要让用户手动编辑配置文件或填写 app_id/app_secret。配置流程对用户来说只需要点击一个链接。

**URL 转发规则**：当命令输出 `verification_url`、`verification_uri_complete`、
`console_url` 等 URL 字段时，必须将 URL exactly as returned by the CLI 转发给用户，
并把它视为不可修改的 opaque string；不要做 URL encode/decode，不要补 `%20`、空格或
标点，不要重新拼接 query，不要改写成 Markdown link text，建议用只包含原始 URL 的
代码块单独输出。

仅在本地维护 CLI 或排查 Ripple 控制面之外的问题时，才考虑手工兜底初始化；处理终端用户请求时不要运行：

```bash
lark-cli config init --new --force-init
```

## 认证

### 身份类型

两种身份类型，通过 `--as` 切换：

| 身份 | 标识 | 获取方式 | 适用场景 |
|------|------|---------|---------|
| user 用户身份 | `--as user` | Ripple 对话授权 | 访问用户自己的资源（日历、云空间等） |
| bot 应用身份 | `--as bot` | 自动，只需 appId + appSecret | 应用级操作，访问 bot 自己的资源 |

### 身份选择原则

输出的 `[identity: bot/user]` 代表当前身份。bot 与 user 表现差异很大，必须先按
"全局默认"一节选好身份，再调用业务 API：

- **默认 `--as user`**：访问用户资源（日历、云空间、邮箱、私聊、用户加入的群）。
- **Bot 看不到用户资源**：`--as bot` 无法访问用户的日历、云空间、邮箱、私聊等个人资源；
  例如 `--as bot` 查日程返回的是 bot 自己的（空）日历。
- **Bot 无法代表用户操作**：发消息以应用名义发送，创建文档归属 bot。
- **Bot 权限**：只需在飞书开发者后台开通 scope，无需用户授权。
- **User 权限**：后台开通 scope + 用户通过 Ripple 对话授权，两层都要满足。

### 权限不足处理

遇到权限相关错误时，**根据当前身份类型采取不同解决方案**。

错误响应中包含关键信息：

- `permission_violations`：列出缺失的 scope（N 选 1）。
- `console_url`：飞书开发者后台的权限配置链接。
- `hint`：建议的修复命令。

#### Bot 身份（`--as bot`）

将错误中的 `console_url` 原样提供给用户，引导去后台开通 scope。**禁止**对 bot 执行
`auth login`。

#### User 身份（`--as user`）-- 授权范围决策

Codex 不负责选择 `--domain` 或 `--scope`，也不负责生成 device-code 链接。遇到 user
授权缺失或 scope 不足时：

1. 停止当前业务命令，不要自行执行 `lark-cli auth login`、`auth login --domain ...` 或
   `auth login --scope ...`。
2. 把 CLI 返回的关键错误、缺失 scope、`console_url` 原样告诉用户。
3. 请用户在对话里说"重新授权飞书"或"飞书补权限"，让 Ripple control plane 重新发起
   Feishu 授权链路。
4. 用户完成授权并回到对话后，再重新执行原业务命令。

**硬性规则**：子 skill 中如果仍看到 `--domain im` / `--domain mail` / `--scope ...`
之类旧示例，不要照抄；以本 skill 为准，授权只能通过 Ripple 对话链路。

#### 错误识别：pending approval 不是用户没点击

如果 CLI 返回：

```json
{"error": {"type": "auth", "message": "authorization failed: Unable to authorize. The app is pending approval."}}
```

这**不是**用户没点链接，而是**飞书开发者后台**这个 scope 需要**管理员审批**但还没批下来。
继续刷新 URL 重试没有意义，正确做法是：

1. 立即停止 device-flow 循环。
2. 告知用户："该 scope 需要飞书开发者后台管理员审批才能授权。请联系应用管理员在开发者后台审批对应权限。"
3. 如果任务能降级用 `--as bot` 完成就降级；否则就此打住，等管理员审批后再继续。

## 高风险操作的审批协议（exit 10）

lark-cli 对高风险写操作（`risk: "high-risk-write"`）有强制确认门禁。当你不带 `--yes`
调用这类命令时，CLI 会退出码 `10`，并在 stderr 返回如下结构化 envelope：

```json
{
  "ok": false,
  "error": {
    "type": "confirmation_required",
    "message": "drive +delete requires confirmation",
    "hint": "add --yes to confirm",
    "risk": {
      "level": "high-risk-write",
      "action": "drive +delete"
    }
  }
}
```

遇到这种情况，按以下流程处理：

1. **识别**：看到子进程 exit code = `10` 且 stderr JSON 里 `error.type == "confirmation_required"`。
2. **向用户确认**：把 `error.risk.action` 和关键参数展示给用户，明确告知"这是高风险操作"，等待用户显式同意。
3. **用户同意**：在原始 argv 的末尾追加 `--yes` 后重试。
4. **用户拒绝**：终止流程，不要擅自改写参数或跳过门禁。

**绝对不允许**：

- 看到 exit 10 就默认加 `--yes` 静默重试。
- 把 `confirmation_required` 当网络错误/权限错误处理。
- 在用户没明确同意的前提下追加 `--yes` 重试。
- 用 `sh -c` 等 shell 方式拼接命令重试；使用参数数组形式，避免 shell 解析把用户参数当作语法。

提前预判：想先让用户 review 危险操作的具体请求，调用时加 `--dry-run`；它不触发门禁，
会打印完整请求详情（URL / body / params），你可以把这个预览给用户看过再去真正执行。

高风险识别方式：

- shortcut：`lark-cli <service> +<cmd> --help` 顶部会显示 `Risk: high-risk-write`。
- service 命令：`lark-cli schema <service>.<resource>.<method> --format json` 的返回值里
  `"risk": "high-risk-write"`。

## 安全规则

- **禁止输出密钥**（appSecret、accessToken）到终端明文。
- **写入/删除操作前必须确认用户意图**。
- 用 `--dry-run` 预览危险请求。
