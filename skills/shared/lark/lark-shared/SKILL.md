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

#### User 身份（`--as user`）

```bash
lark-cli auth login --domain <domain>           # 按业务域授权
lark-cli auth login --scope "<missing_scope>"   # 按具体 scope 授权（推荐,符合最小权限原则）
```

**规则**：auth login 必须指定范围（`--domain` 或 `--scope`）。多次 login 的 scope 会累积（增量授权）。

#### Agent 代理发起认证（两段式，非阻塞）

bash 工具有默认超时，**绝对不要**用阻塞式 `lark-cli auth login`。使用官方
为 Agent 设计的 `--no-wait` + `--device-code` 两段式流程：

**第 1 步**：立即返回授权 URL 和 device_code（不阻塞）

```bash
lark-cli auth login --no-wait --json --scope "calendar:calendar:readonly"
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
- 若第 2 步报 `pending` / `not yet completed`，说明用户还没完成，请先等待用户确认再重试


## 更新与维护

lark-cli 由宿主机管理员统一预装（路径 `/usr/local/bin/lark-cli`），不要尝试
在沙箱内用 `npm install -g` 升级。如果命令输出 `_notice.update`，完成当前
请求后告知用户："飞书 CLI 有新版本可用，请联系管理员在宿主机升级。"

## 安全规则

- **禁止输出密钥**（appSecret、accessToken）到终端明文。
- **写入/删除操作前必须确认用户意图**。
- 用 `--dry-run` 预览危险请求。
