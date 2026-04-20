---
name: lark-shared
version: 1.0.0
description: "飞书/Lark CLI 共享基础：应用配置初始化、认证登录（auth login）、身份切换（--as user/bot）、权限与 scope 管理、Permission denied 错误处理、安全规则。当用户需要第一次配置(`lark-cli config init`)、使用登录授权(`lark-cli auth login`)、遇到权限不足、切换 user/bot 身份、配置 scope、或首次使用 lark-cli 时触发。"
---

# lark-cli 共享规则

本技能指导你如何通过lark-cli操作飞书资源, 以及有哪些注意事项。

## ⚠️ 首要步骤：状态检查

**调用任何 lark-cli 业务命令之前，必须先检查配置和认证状态：**

```bash
lark-cli config show 2>&1 && lark-cli auth status 2>&1
```

根据返回结果判断：
1. **`config` 返回 `"not configured"`** → app 凭证未配置，直接运行任意 `lark-cli` 命令即可触发自动配置流程（系统会生成配置链接）
2. **`config` 正常但 `auth` 未登录** → bot 身份可直接使用；user 身份需先完成 auth login
3. **两者都正常** → 直接执行业务命令

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

输出的 `[identity: bot/user]` 代表当前身份。bot 与 user 表现差异很大，需确认身份符合目标需求：

- **Bot 看不到用户资源**：无法访问用户的日历、云空间文档、邮箱等个人资源。例如 `--as bot` 查日程返回 bot 自己的（空）日历
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

本环境是**可信的单人本地 Agent 场景**，用户操作链路较长、跨多个业务域，重复授权会
严重损伤体验。**默认按"一次性批量授权"执行**，不要再套用"最小权限原则"。

授权粒度有三档，按如下优先级选择：

1. **`--domain all`（首选）** — 一次性拿到所有业务域的 scope，用户只需点击一次链接
2. **`--domain <a,b,c>`（次选）** — 明确只涉及少数几个域时，按任务速查表挑选
3. **`--scope "<xxx>"`（兜底）** — 仅在 1/2 已用过、命令仍然报 `missing_scope` 时使用

任务 → domain 速查表（仅当你**确定**要收窄范围时才用；否则直接 `--domain all`）：

| 任务 | domain |
|------|--------|
| 搜联系人、发 IM 消息 | `contact,im` |
| 日历读写 | `calendar,contact` |
| 云文档、Drive、Wiki | `docs,drive,wiki,docx` |
| 多维表格 | `base` |
| 邮件 | `mail` |
| 全部任务 / 用户说"帮我授权" | `all` |

**规则**：
- `auth login` 必须带 `--domain` 或 `--scope`（`--no-wait` 场景下两者至少指定一个）
- 多次 login 的 scope 会**累积**（增量授权，不会覆盖之前的授权）
- **不要**为了"最小权限"而把单个 `auth login` 拆成多次 —— 这不是企业 server-to-server，而是本人代理本人，拆分只会让用户反复点链接

#### Agent 代理发起认证（两段式，非阻塞）

bash 工具有默认超时，**绝对不要**用阻塞式 `lark-cli auth login`。使用官方
为 Agent 设计的 `--no-wait` + `--device-code` 两段式流程：

**第 1 步**：立即返回授权 URL 和 device_code（不阻塞）

```bash
# 默认首选：一次性授权所有业务域
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
