---
name: lark-shared
version: 1.1.0
description: "飞书/Lark CLI 共享基础：应用配置初始化、认证登录（auth login）、身份切换（--as user/bot）、权限与 scope 管理、Permission denied 错误处理、安全规则。当用户需要第一次配置(`lark-cli config init`)、使用登录授权(`lark-cli auth login`)、遇到权限不足、切换 user/bot 身份、配置 scope、或首次使用 lark-cli 时触发。"
---

# lark-cli 共享规则

本技能指导你如何通过lark-cli操作飞书资源, 以及有哪些注意事项。

## 运行环境前提（重要）

lark-cli 跑在**单人本地 Agent 沙箱**里：每个用户拥有独立的 nsjail 沙箱、独立的
`/workspace/.lark-cli/config.json` 与 access token，凭证天然隔离。**这不是企业
server-to-server 场景**，没有"多租户串号"风险，因此本 skill 体系**全面放弃"最小
权限原则"**，全部默认按"一次性、最大化"授权，最大程度减少用户被打断点链接的次数。

## 全局默认（所有 lark-cli 操作都要遵守）

1. **身份默认：`--as user`** —— 凡是同时支持 `user` 与 `bot` 的 API，**必须显式
   带上 `--as user`**。CLI 底层默认是 `bot`，不显式指定会以应用身份发送/读取，
   行为与用户预期完全不同。
2. **授权默认：`--domain all`** —— `auth login` 默认一次性拿全域 scope，**禁止**
   出于"最小权限"动机把单次 login 拆成多次窄域 login。
3. 切换到 `--as bot` 仅限三种情况：
   - 用户在当前消息里**明确**要求"以应用 / bot 身份执行"；
   - 当前 API **只支持 bot**（如 `im.messages.forward`、`im.messages.merge_forward`、
     `im.images.create`、`im.chats.create` 等，子 skill 会标注 `Identity: bot only`）；
   - 当前工作流就是 bot 主动播报、在 bot 自己所在群里以应用身份发言。
4. 切换到窄域 `--domain <a,b>` / `--scope "<xxx>"` 仅限两种情况：
   - 用户在当前消息里**明确**要求"只授权某某权限 / 走最小权限"；
   - 命令在 `--domain all` 之后仍然报 `missing_scope`（属于 scope 表外的边角权限）。

子 skill 不需要重复声明这两条默认；如果某个子 skill 与上面的默认相反（例如某个
API 只支持 bot），它会**显式覆盖**这条规则，否则一律按本节默认执行。

## ⚠️ 首要步骤：状态检查

**调用任何 lark-cli 业务命令之前，必须先检查配置和认证状态：**

```bash
lark-cli config show 2>&1 && lark-cli auth status 2>&1
```

根据返回结果判断：
1. **`config` 返回 `"not configured"`** → app 凭证未配置，直接运行任意 `lark-cli` 命令即可触发自动配置流程（系统会生成配置链接）
2. **`config` 正常但 `auth` 未登录** → 默认走 user 身份，先按下方"Agent 代理发起认证"流程完成 `auth login --domain all`；只有当本次任务确属"bot only"或用户明确要求 bot 时，才能跳过 auth login 直接以 `--as bot` 调用
3. **两者都正常** → 直接执行业务命令（仍然显式带 `--as user`）

**绝对不要跳过这一步直接调用业务 API。**

## 配置初始化

app 凭证配置是**全自动**的：

1. 首次运行 `lark-cli` 命令时，系统检测到未配置会自动启动 `config init --new`
2. 系统返回一个配置链接（`[FEISHU_SETUP]` 标记）
3. **将链接发给用户**，用户点击链接即可完成飞书应用创建
4. 用户完成后，重新执行命令即可正常使用

**重要**：不要让用户手动编辑配置文件或填写 app_id/app_secret。配置流程对用户来说只需要点击一个链接。

## 认证

### 身份类型

两种身份类型，通过 `--as` 切换：

| 身份 | 标识 | 获取方式 | 适用场景 |
|------|------|---------|---------|
| user 用户身份 | `--as user` | `lark-cli auth login` 等 | 访问用户自己的资源（日历、云空间等） |
| bot 应用身份 | `--as bot` | 自动，只需 appId + appSecret | 应用级操作,访问bot自己的资源 |

### 身份选择原则

输出的 `[identity: bot/user]` 代表当前身份。bot 与 user 表现差异很大，必须先按
"全局默认"一节选好身份，再调用业务 API：

- **默认 `--as user`**：访问用户资源（日历、云空间、邮箱、私聊、用户加入的群）
- **Bot 看不到用户资源**：`--as bot` 无法访问用户的日历、云空间、邮箱、私聊等个人资源；
  例如 `--as bot` 查日程返回的是 bot 自己的（空）日历
- **Bot 无法代表用户操作**：发消息以应用名义发送，创建文档归属 bot
- **Bot 权限**：只需在飞书开发者后台开通 scope，无需 `auth login`
- **User 权限**：后台开通 scope + 用户通过 `auth login` 授权，两层都要满足


### 权限不足处理

遇到权限相关错误时，**根据当前身份类型采取不同解决方案**。

错误响应中包含关键信息：
- `permission_violations`：列出缺失的 scope (N选1)
- `console_url`：飞书开发者后台的权限配置链接
- `hint`：建议的修复命令

#### Bot 身份（`--as bot`）

将错误中的 `console_url` 提供给用户，引导去后台开通 scope。**禁止**对 bot 执行 `auth login`。

#### User 身份（`--as user`）—— 授权范围决策

按"全局默认"一节，**永远先用 `--domain all`**。三档粒度的关系仅供"用户明确要求收窄"
或"all 之后仍报 `missing_scope`"时使用：

1. **`--domain all`（默认且唯一推荐）** — 一次性拿到所有业务域 scope，用户只点一次链接
2. **`--domain <a,b,c>`（不推荐）** — 仅当用户**明确要求最小权限**时才用；不要"自作主张"
   收窄
3. **`--scope "<xxx>"`（兜底）** — 仅在 `--domain all` 之后命令仍然报 `missing_scope`
   且错误响应里给出了具体 scope 名时使用

**硬性规则**：
- `auth login` 必须带 `--domain` 或 `--scope`（`--no-wait` 场景下两者至少指定一个）
- 多次 login 的 scope 会**累积**（增量授权，不会覆盖之前的授权）
- **绝对不要**为了"最小权限"主动把单次 login 拆成多次 —— 沙箱场景下凭证天然隔离，
  拆分只会让用户反复点链接、严重损伤体验
- **绝对不要**在子 skill 里看到 `--domain im` / `--domain mail` 之类的旧示例就照抄；
  以本 skill 为准，统一用 `--domain all`

> 原"任务 → domain 速查表"已删除：保留它会持续诱导 agent 选窄域；如果以后有
> "用户明确要求最小权限"的任务，再现场按 `lark-cli auth login --help` 列出的
> domain 名挑选即可。

#### Agent 代理发起认证（两段式，非阻塞）

bash 工具有默认超时，**绝对不要**用阻塞式 `lark-cli auth login`。使用官方
为 Agent 设计的 `--no-wait` + `--device-code` 两段式流程：

**第 1 步**：立即返回授权 URL 和 device_code（不阻塞）

```bash
# 标准命令：一次性授权所有业务域，子 skill 不应再写其它 --domain 取值
lark-cli auth login --no-wait --json --domain all
```

从 JSON 输出中提取：
- `verification_url` / `url` — 把这个链接标注为 `[FEISHU_AUTH]` 发给用户
- `device_code` — 保存，第 2 步会用到

**第 2 步**：用户在浏览器完成授权后，用 device_code 轮询完成登录

```bash
lark-cli auth login --device-code <DEVICE_CODE>
```

这一步阻塞时间很短（仅做一次 token 交换），不会卡超时。

**规则**：
- 同一 session 里同一次授权流程的 device_code 不要重复使用
- 若第 2 步报 `pending` / `not yet completed`，说明用户还没完成浏览器端操作，**等待用户明确告知"已授权"后**再重试（不要自行循环轮询）

#### 错误识别：pending approval ≠ 用户没点击

如果 `auth login --device-code ...` 返回：

```json
{"error": {"type": "auth", "message": "authorization failed: Unable to authorize. The app is pending approval."}}
```

这**不是**用户没点链接，而是**飞书开发者后台**这个 scope 需要**管理员审批**但还没批下来。继续刷新 URL 重试没有任何意义，正确做法是：

1. 立即停止 device-flow 循环
2. 告知用户："该 scope 需要飞书开发者后台管理员审批才能授权。请联系应用管理员在 [开发者后台](https://open.feishu.cn/app) 审批对应权限。"
3. 如果任务能降级用 `--as bot` 完成就降级；否则就此打住，等管理员审批后再继续


## 更新与维护

lark-cli 是 Go 静态二进制，由项目脚本 `scripts/install-feishu-cli.sh` 安装到
仓库内 `vendor/lark-cli/`，沙箱启动时 readonly bind-mount 到 `/opt/lark-cli`
并已加入 `PATH`，可直接调用 `lark-cli`。**不要**尝试用 `npm install -g`
或 `pnpm install -g` 安装/升级（它不是 npm 包）。

## 安全规则

- **禁止输出密钥**（appSecret、accessToken）到终端明文。
- **写入/删除操作前必须确认用户意图**。
- 用 `--dry-run` 预览危险请求。
