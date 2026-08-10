# Google Workspace 生产 OAuth 企业管理员配置指南

本文用于把 Ripple 的 Google Workspace OAuth 生产配置工作交给企业 Google Cloud / Google Workspace 管理员执行。

目标是由企业统一创建和管理一个生产级 Google Web OAuth Client，供 Ripple Server 发起用户授权。每个最终用户仍使用自己的 Google 账号完成 OAuth consent，Ripple 不使用个人测试账号的 Client，也不使用 Service Account 或 Domain-wide Delegation 代替用户授权。

> 安全要求：Client Secret 只能通过企业密码管理器、Secret Manager 或其他受控渠道交付。不要通过聊天、工单正文、普通邮件或代码仓库传递。曾经在不安全渠道出现过的 Client Secret 必须废弃并重新创建。

## 0. 给企业管理员的简要说明

### 0.1 为什么要做，有什么用

这项工作是为了让 Ripple 能以企业正式应用的身份连接用户的 Google Workspace。

配置完成后，用户可以在 Google 官方授权页面选择自己的 Google 账号并授权 Ripple。获得用户许可后，Ripple 才能通过 `gog` 使用用户允许的 Google 服务：

- Gmail
- Google Drive
- Google Calendar
- Google Docs
- Google Sheets
- Google Slides

测试 OAuth Client 只适合开发和内部测试，存在测试用户数量限制、授权过期和未验证应用警告。生产 OAuth Client 用于形成可长期运维、可接受 Google 审核、能够提供给外部用户使用的正式授权入口。

### 0.2 大概流程、需要做什么、需要什么权限

企业管理员需要完成以下工作：

1. 创建独立的生产 Google Cloud Project。
2. 启用 Gmail、Drive、Calendar、Docs、Sheets、Slides API。
3. 验证企业正式域名所有权。
4. 在 Google Auth Platform 配置应用名称、Logo、产品首页、隐私政策、服务条款、支持邮箱和 External Audience。
5. 声明 Ripple 实际申请的 Google OAuth scopes。
6. 创建 `Web application` 类型的 OAuth Client。
7. 把 Ripple 的正式 HTTPS callback 添加到 Authorized redirect URIs。
8. 在企业 Workspace 管理策略中放行指定测试账号，并完成端到端授权测试。
9. 发布应用并提交 Google OAuth verification。
10. 如果 Google 判定所申请的 Gmail、完整 Drive 等权限属于 Restricted Scopes，配合完成第三方安全评估。

通常需要以下管理权限或人员协作：

- Google Cloud Organization、Project 或 Billing 管理权限，用于创建和管理生产项目。
- Google Cloud API 与 Google Auth Platform 管理权限，用于启用 API、配置 Branding、Audience、Data Access 和 OAuth Client。
- 企业 DNS 与 Google Search Console 权限，用于验证正式域名。
- Google Workspace Admin Console 权限，用于允许企业测试账号访问该 OAuth 应用。
- 企业法务、隐私或安全人员，审核隐私政策、服务条款、用户数据使用说明及安全评估材料。

管理员在 Workspace Admin Console 中允许该应用，并不等于替用户授权数据。Ripple 当前不使用 Domain-wide Delegation；每个最终用户仍需在 Google 官方授权页面选择账号并点击 Allow。

### 0.3 最终需要提供给开发者什么

管理员最终需要向 Ripple 部署负责人提供：

```text
Google Cloud Project ID
Web OAuth Client ID
Web OAuth Client Secret
Authorized redirect URI
```

同时需要确认：

- Gmail、Drive、Calendar、Docs、Sheets、Slides API 已启用。
- Audience 已设置为 `External`；正式发布时状态为 `In production`。
- 企业正式域名已经验证。
- Authorized redirect URI 与 Ripple callback 完全一致。
- OAuth scopes 已在 Data Access 中声明。
- Branding、Data Access verification 和安全评估的当前状态。

开发者会把这些内容配置到 Ripple Server，目标形态如下：

```yaml
gogcli_oauth:
  auto_from_request: false
  auto_register_client: true
  callback_url: "https://正式域名/v1/sandboxes/gogcli/oauth/callback"
  client:
    type: "web"
    client_id: "<CLIENT_ID>"
    client_secret: "<CLIENT_SECRET>"
    project_id: "<PROJECT_ID>"
```

Client Secret 必须通过 Secret Manager、企业密码管理器或一次性秘密链接交付，不能发送到聊天、普通邮件、工单正文或代码仓库。

## 1. 管理员最终需要交付什么

配置完成后，请向 Ripple 部署负责人交付以下内容。

| 交付项 | 必需 | 说明 |
| --- | --- | --- |
| Google Cloud Project ID | 是 | 独立生产项目的 `project_id` |
| Web OAuth Client ID | 是 | 以 `.apps.googleusercontent.com` 结尾 |
| Web OAuth Client Secret | 是 | 只通过受控秘密渠道交付；不要写入文档或聊天 |
| Authorized redirect URI | 是 | 确认已登记与 Ripple 配置完全一致的 HTTPS callback |
| OAuth Audience 状态 | 是 | 对外服务应为 `External`；正式发布时为 `In production` |
| Branding 状态 | 是 | 已填写并发布应用名称、首页、隐私政策、服务条款和联系邮箱 |
| Data Access scope 清单 | 是 | 已声明本文列出的当前 Ripple scopes，并反馈 Google 的分类和验证状态 |
| API 启用清单 | 是 | Gmail、Drive、Calendar、Docs、Sheets、Slides API 均已启用 |
| 域名验证结果 | 是 | 正式域名已由项目 Owner/Editor 在 Search Console 验证 |
| Verification Center 状态 | 是 | 说明未提交、审核中、已批准或需要安全评估 |
| 企业测试账号策略 | 建议 | 说明生产 Client 是否已在企业 Workspace Admin Console 中设为允许/可信 |

Client Secret 最好由管理员直接写入生产 Secret Manager 或部署系统，不把明文交给开发人员。如果必须交付明文，应使用一次性秘密链接并在读取后销毁。

## 2. Ripple 部署负责人需要先提供给管理员什么

管理员开始前，Ripple 部署负责人需要确认并提供以下信息。

### 2.1 应用信息

- 正式应用名称，例如 `Ripple`。
- 用户支持邮箱。
- 开发者/安全联系邮箱。
- 应用 Logo。
- 公开可访问的产品首页；不能只有登录页面。
- 隐私政策 URL。
- 服务条款 URL。
- 用户数据删除和撤销授权说明 URL。

首页、隐私政策和服务条款应使用企业拥有并可验证的同一主域名。

### 2.2 正式 OAuth 域名与 callback

向管理员提供唯一、确定的生产 callback，例如：

```text
https://oauth.example.com/v1/sandboxes/gogcli/oauth/callback
```

如果暂时继续使用现有地址，则完整值是：

```text
https://test-oauth.weilai.ai/v1/sandboxes/gogcli/oauth/callback
```

生产 callback 必须满足：

- 使用 HTTPS。
- 使用企业拥有的域名，不能使用公网裸 IP。
- 无需登录即可接收 Google callback。
- 路径、大小写、端口、结尾斜杠与 Google Console 登记值完全一致。
- 从目标用户所在网络能够访问。

如果 `test-oauth.weilai.ai` 仍存在备案、拦截或公网访问问题，应先启用稳定的正式域名，再创建生产 Client。

### 2.3 当前 Ripple 实际申请的 scopes

当前服务端在一次 OAuth 请求中申请以下 scopes。Google Auth Platform 的 Data Access 页面必须声明完全相同的集合：

```text
openid
email
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.settings.basic
https://www.googleapis.com/auth/gmail.settings.sharing
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/spreadsheets
```

其中 Gmail 和完整 Drive 权限包含 Restricted Scopes。对外生产应用需要 Data Access verification，并可能需要 Google 认可的第三方机构进行年度安全评估。

`gmail.settings.sharing` 主要面向 Google Workspace 管理员使用 Service Account + Domain-wide Delegation 的管理场景，而 Ripple 当前使用普通用户 OAuth。管理员不应为不存在的功能提供虚假 justification；如果 Google 要求说明或拒绝该 scope，应把结果反馈给 Ripple 产品/开发负责人。创建 Client 不受此影响，但完整生产审核可能因此无法通过。

## 3. 需要哪些管理员角色

本流程通常需要多人协作，不建议把所有长期权限集中到一个个人账号。

| 管理范围 | 需要具备的能力 |
| --- | --- |
| Google Cloud Organization / Billing | 创建生产 Project、关联 Billing Account |
| Google Cloud Project | 管理 API、Google Auth Platform、OAuth Client、项目联系人和 IAM |
| DNS / Search Console | 为正式主域名添加 DNS TXT 记录并验证 Domain Property |
| Google Workspace Admin | 管理企业测试账号对第三方 OAuth App 的访问策略 |
| 法务/隐私/安全 | 审核首页、隐私政策、服务条款、数据删除和 AI 数据处理披露 |

执行 Search Console 域名验证的 Google 账号必须同时是目标 Google Cloud Project 的 Owner 或 Editor，否则 OAuth verification 可能无法识别域名所有权。

## 4. 管理员详细操作步骤

### 步骤 1：创建独立生产 Google Cloud Project

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)。
2. 点击页面顶部的项目选择器。
3. 点击“新建项目”。
4. 建议填写：

   ```text
   Project name: Ripple Production
   Project ID:   ripple-production-<企业后缀>
   Organization: <企业 Google Cloud Organization>
   Location:     <企业指定 Folder>
   ```

5. 创建项目后，确认当前页面选中的就是新生产项目。
6. 按企业规范关联 Billing Account。
7. 至少配置两个长期有效的项目 Owner/Editor 或等效受控管理员账号，避免验证邮件只发送给离职或个人账号。
8. 不要复用个人测试项目；开发/测试和生产应使用不同项目。

完成标准：

- 有独立、可长期运维的生产 Project ID。
- 项目归属企业 Organization，而不是个人 Google 账号。
- 项目联系人和 Billing 状态正常。

### 步骤 2：启用 Google Workspace APIs

在生产项目中进入：

```text
APIs & Services → Library
```

逐一搜索并点击 `Enable`：

- Gmail API
- Google Drive API
- Google Calendar API
- Google Docs API
- Google Sheets API
- Google Slides API

启用后进入：

```text
APIs & Services → Enabled APIs & services
```

确认六个 API 全部存在。不要只创建 OAuth Client 而遗漏 API，否则用户授权成功后业务调用会返回 `403 accessNotConfigured`。

完成标准：六个 API 均显示 Enabled。

### 步骤 3：验证正式域名所有权

1. 使用目标生产项目的 Owner/Editor 账号打开 [Google Search Console](https://search.google.com/search-console/)。
2. 点击“添加资源”。
3. 选择 `Domain`，不要只选择 URL Prefix。
4. 输入正式根域名，例如：

   ```text
   weilai.ai
   ```

5. 复制 Google 提供的 DNS TXT 记录。
6. 在企业 DNS 服务商中添加该 TXT 记录。
7. 等待 DNS 生效后点击 Verify。
8. 回到 Google Auth Platform，确认该根域名能够加入 Authorized domains。

验证根域名后，可以在 OAuth 中使用其子域名，例如 `oauth.weilai.ai` 或 `test-oauth.weilai.ai`。

完成标准：Search Console 的 Domain Property 显示已验证，验证账号同时是生产 Project Owner/Editor。

### 步骤 4：配置 Google Auth Platform Branding

在生产项目中进入：

```text
Google Auth Platform → Branding
```

依次填写：

1. App name：正式产品名称，例如 `Ripple`。
2. User support email：用户可以实际联系到的支持邮箱。
3. App logo：与产品页面一致的正式 Logo。
4. App home page：公开可访问、无需登录的产品首页。
5. Privacy policy：正式隐私政策 URL。
6. Terms of service：正式服务条款 URL。
7. Authorized domains：填写根域名，例如 `weilai.ai`，不要填写完整 callback 路径。
8. Developer contact information：填写长期有效的开发和安全联系邮箱。

管理员需要检查：

- OAuth consent screen、首页和 Logo 使用相同产品名称。
- 首页清楚说明 Google Workspace 集成功能及申请数据的目的。
- 首页直接链接隐私政策和服务条款。
- 隐私政策说明 Google 数据的访问、使用、存储、共享、删除和撤销方式。
- 隐私政策说明 Google 数据是否会进入 Codex/AI 执行链路，并声明不会用于训练超出用户功能范围的通用 AI 模型。
- 隐私政策包含遵守 Google API Services User Data Policy 和 Limited Use 要求的声明。

完成标准：Branding 信息完整、URL 可公开访问、域名已验证，页面状态可进入发布/验证流程。

### 步骤 5：配置 Audience

进入：

```text
Google Auth Platform → Audience
```

1. 对外服务选择 `External`。
2. 初次配置先保持 `Testing`。
3. 把 Ripple 指定的企业测试账号加入 Test users。
4. 完成 Client 创建和端到端测试后，再点击 `Publish App`，切换为 `In production`。

不要选择 `Internal`，除非明确只允许同一个 Google Workspace / Cloud Identity Organization 内的员工使用。`Internal` 应用不能供外部 Google 账号正常授权。

完成标准：

- 联调阶段为 External + Testing，并已添加测试账号。
- 正式提交验证前为 External + In production。

### 步骤 6：配置 Data Access scopes

进入：

```text
Google Auth Platform → Data Access
```

1. 点击 `Add or remove scopes`。
2. 选择本文 2.3 节列出的全部 scopes。
3. 如果某个 scope 没有出现在列表中：
   - 先确认对应 API 已启用；
   - 再使用 `Manually add scopes` 输入完整 scope URI。
4. 点击 `Update`。
5. 记录 Google 对每个 scope 的分类：Non-sensitive、Sensitive 或 Restricted。
6. 对 Sensitive/Restricted scopes 准备真实、逐项的业务用途说明。

建议管理员使用下表向 Ripple 产品负责人收集 justification，不能用“未来可能使用”或“为了方便”作为理由。

| Scope | 当前预期用途 | 管理员需要确认的问题 |
| --- | --- | --- |
| `openid` / `email` / `userinfo.email` | 识别用户实际授权的 Google 账号 | 是否只用于显示和选择已绑定账号 |
| `calendar` | 查询、创建、更新和响应日历事件 | Ripple UI 中对应功能和用户触发方式是什么 |
| `documents` | 读取和编辑 Google Docs | 为什么不能只操作用户选择的文件 |
| `drive` | 搜索、读取和管理用户 Drive 文件 | 为什么 `drive.file` 等更窄权限不能满足功能 |
| `gmail.modify` | 搜索、读取、发送和修改邮件/标签 | 哪些界面展示邮件，哪些动作需要写权限 |
| `gmail.settings.basic` | 查询或修改 Gmail 基础设置/过滤器 | 产品是否已有对应可见功能 |
| `gmail.settings.sharing` | Gmail 管理级共享设置 | 当前普通用户 OAuth 是否实际可用；若无功能应反馈风险 |
| `presentations` | 读取和编辑 Google Slides | 哪些用户操作会触发 |
| `spreadsheets` | 读取和编辑 Google Sheets | 哪些用户操作会触发 |

完成标准：Data Access 页面中的 scope 集合与 Ripple 实际 OAuth 请求一致，并已保存每个 scope 的分类和 justification 草稿。

### 步骤 7：创建生产 Web OAuth Client

进入：

```text
Google Auth Platform → Clients
```

1. 点击 `Create Client`。
2. Application type 选择 `Web application`。
3. Name 建议填写：

   ```text
   Ripple Production Web
   ```

4. `Authorized JavaScript origins` 保持为空。当前 Ripple 是服务端发起 OAuth 并由服务端 callback，不需要浏览器 JavaScript 直接换取 Google token。
5. 在 `Authorized redirect URIs` 点击 `Add URI`。
6. 粘贴 Ripple 部署负责人提供的完整 callback，例如：

   ```text
   https://oauth.example.com/v1/sandboxes/gogcli/oauth/callback
   ```

7. 检查以下细节：
   - 必须是 HTTPS；
   - 不能是公网裸 IP；
   - 不要添加查询参数；
   - 不要擅自增加或删除结尾斜杠；
   - 不要把首页 URL 当作 redirect URI；
   - 生产 Client 中只保留必要的生产 callback。
8. 点击 `Create`。
9. 立即记录 Client ID，并把 Client Secret 存入企业 Secret Manager 或密码管理器。

Google可能只在 Client 创建时完整展示一次 Client Secret。不要截图后发群聊，不要粘贴到工单，不要提交到 Git。

完成标准：生产 Web Client 已创建，Authorized redirect URI 与 Ripple 配置逐字符一致，Client Secret 已进入受控秘密存储。

### 步骤 8：配置企业 Workspace 测试账号访问策略

此步骤由 Google Workspace Super Admin 或拥有 API Controls 权限的管理员执行，用于避免企业测试账号被组织策略拦截。

在 [Google Admin Console](https://admin.google.com/) 中进入类似路径：

```text
Security → Access and data control → API controls
→ Manage Third-Party App Access
```

不同企业版本的菜单名称可能略有差异。操作目标是：

1. 按生产 OAuth Client ID 查找或添加 Ripple 应用。
2. 为指定测试 Organizational Unit / Group 配置允许访问。
3. 根据企业安全策略设置为 Trusted 或 Limited，并确保本文要求的 scopes 未被组织策略阻断。
4. 优先只对测试 OU/Group 放开，验证通过后再按企业政策扩大范围。

重要边界：

- 将应用设为 Trusted/Allowed 只是允许组织内用户发起 OAuth。
- 它不会替代终端用户 consent，也不会自动授予用户邮件、Drive 或日历数据。
- 每个最终用户仍需在 Google 授权页面选择账号并点击 Allow。
- Ripple 当前不使用 Service Account 和 Domain-wide Delegation，不应为它配置全域委派。
- 外部客户所属 Google Workspace 的管理员仍可能阻止第三方应用；本企业管理员无法替所有外部组织统一放行。

完成标准：指定企业测试账号不会因组织 API Controls 策略被阻断，同时没有配置 Domain-wide Delegation。

### 步骤 9：把生产 OAuth 配置交给 Ripple 部署负责人

管理员应提供以下非秘密信息：

```yaml
project_id: "<PRODUCTION_PROJECT_ID>"
client_id: "<PRODUCTION_CLIENT_ID>.apps.googleusercontent.com"
callback_url: "https://oauth.example.com/v1/sandboxes/gogcli/oauth/callback"
```

Client Secret 单独通过 Secret Manager 或一次性秘密渠道交付。Ripple 生产配置目标形态为：

```yaml
gogcli_oauth:
  auto_from_request: false
  auto_register_client: true
  callback_url: "https://oauth.example.com/v1/sandboxes/gogcli/oauth/callback"
  client:
    type: "web"
    client_id: "<PRODUCTION_CLIENT_ID>.apps.googleusercontent.com"
    client_secret: "<PRODUCTION_CLIENT_SECRET>"
    project_id: "<PRODUCTION_PROJECT_ID>"
```

说明：

- `auto_from_request: false` 是生产推荐配置，因为 callback 已显式固定；这不需要修改代码。
- 如果暂时保留 `true`，当前实现仍会优先使用显式 `callback_url`。
- `config/settings.yaml` 必须保持 Git ignored，并限制宿主机文件读取权限。
- Client ID 可以出现在配置核对材料中；Client Secret 不可以。

完成标准：部署负责人已经安全获得 Project ID、Client ID 和 Client Secret，并确认 callback 完全一致。

### 步骤 10：完成联调验证

Ripple 部署负责人配置生产 Client 后，管理员配合使用企业测试账号完成以下验证：

1. 从 Ripple 发起 Google Workspace 连接。
2. 检查跳转域名必须是 Google 官方授权页面。
3. 检查授权页面显示的应用名称和 Logo 与正式 Branding 一致。
4. 检查授权 URL 中的 `client_id` 是生产 Client ID，而不是旧测试 Client ID。
5. 完成 Allow。
6. callback 页面显示授权完成。
7. Ripple 账号列表显示用户实际选择的 Google 邮箱。
8. 分别执行最小只读测试：
   - Gmail 搜索一封测试邮件；
   - Drive 列出或搜索一个测试文件；
   - Calendar 查询测试日程；
   - Docs 读取测试文档；
   - Sheets 读取测试表格；
   - Slides 读取测试演示文稿。
9. 测试断开授权后，Ripple 不再能调用该账号。
10. 如需测试写操作，应使用专门测试账号和测试资源，并遵守 Ripple 的二次确认规则。

注意：Ripple 当前会把 OAuth Client 配置复制到每个 user sandbox。已经用旧测试 Client 授权过的用户不会自动切换生产 Client，必须先断开账号、清理该 user 的旧 `gogcli-client.json`，再重新授权。旧 Client 的 refresh token 不能迁移到新生产 Client。

完成标准：六项 API 的最小调用成功，不出现 `redirect_uri_mismatch`、`accessNotConfigured`、`access_denied` 或 `invalid_grant`。

### 步骤 11：发布 Branding 和 Audience

完成测试后：

1. 回到 `Google Auth Platform → Branding`，检查所有内容与实际产品一致。
2. 发布 Branding。
3. 进入 `Audience`。
4. 点击 `Publish App`，把应用切换为 `External / In production`。
5. 确认项目 Owner/Editor、支持邮箱和开发者联系邮箱可以正常收信。

发布到 In production 不等于 scopes 已验证。未通过 Sensitive/Restricted Data Access verification 时，外部用户仍可能看到 unverified app 警告，并受用户数量限制。

### 步骤 12：提交 Data Access verification

进入：

```text
Google Auth Platform → Verification Center
```

按页面要求提交：

1. 已发布的 Branding。
2. 全部 Sensitive/Restricted scopes。
3. 每个 scope 的详细、真实 justification。
4. 最多三个相关产品功能文档链接。
5. 可供 Google 审核人员理解和验证功能的操作说明。
6. 一段完整演示视频，通常以 Unlisted YouTube 链接提交。

演示视频至少应展示：

- Ripple 公开首页和产品名称。
- 用户主动点击连接 Google Workspace。
- 完整 OAuth consent screen；建议将授权页面语言切换成英文。
- consent screen 显示与提交审核完全相同的 scopes。
- 用户完成授权并返回 Ripple。
- Gmail、Drive、Calendar、Docs、Sheets、Slides 对应功能如何使用这些 scopes。
- 用户如何断开授权、撤销权限和请求删除数据。
- 如果 Google 数据会进入 AI/Codex 处理，展示用户知情和控制入口。

Google审核团队会通过项目 Owner/Editor 和 Developer contact 邮箱沟通。收到补充材料请求后应在期限内回复。

### 步骤 13：完成 Restricted Scope 安全评估

因为当前 Ripple 申请 Gmail 和完整 Drive Restricted Scopes，并由服务端访问或传输数据，Google可能要求使用其认可的第三方评估机构完成安全评估。

管理员需要：

1. 等待 Google verification 团队确认评估要求和范围。
2. 选择 Google认可的评估机构。
3. 协调 Ripple 的安全架构、数据流、加密、访问控制、日志、漏洞管理、事件响应和数据删除材料。
4. 修复评估发现的问题。
5. 取得 Letter of Assessment 或 Google要求的等效材料。
6. 按 Google要求完成后续验证。
7. 记录年度复评日期；Restricted Scope 安全评估通常至少每 12 个月需要重新完成。

如果产品暂时不能满足评估要求，不应把“已创建 OAuth Client”描述为已经生产审核通过。

## 5. 管理员回传模板

管理员完成后，可复制以下模板回复 Ripple 部署负责人。不要在模板中填写 Client Secret。

```text
Google Workspace 生产 OAuth 配置结果

1. Google Cloud
- Project name:
- Project ID:
- Organization / Folder:
- Billing linked: Yes / No
- Project contacts checked: Yes / No

2. Domain
- Verified root domain:
- Search Console Domain Property verified: Yes / No
- Verification account is Project Owner/Editor: Yes / No

3. APIs
- Gmail API: Enabled / Disabled
- Drive API: Enabled / Disabled
- Calendar API: Enabled / Disabled
- Docs API: Enabled / Disabled
- Sheets API: Enabled / Disabled
- Slides API: Enabled / Disabled

4. Google Auth Platform
- App name:
- Audience: External / Internal
- Publishing status: Testing / In production
- Branding status:
- Data Access status:
- Verification Center status:
- Security assessment required: Yes / No / Pending Google decision

5. OAuth Client
- Client type: Web application
- Client name:
- Client ID:
- Authorized redirect URI:
- Client Secret storage location: <只写 Secret Manager 路径或交付方式，不写明文>

6. Workspace Admin
- Production Client allowed for test OU/Group: Yes / No / Not applicable
- Domain-wide Delegation configured: No

7. Outstanding issues
- <列出 Google 审核问题、待补材料或组织策略限制>
```

## 6. 常见错误与处理

| 错误 | 常见原因 | 管理员处理 |
| --- | --- | --- |
| `redirect_uri_mismatch` | Google Client 中的 URI 与 Ripple 请求不完全一致 | 对比协议、域名、端口、路径和结尾斜杠 |
| `accessNotConfigured` | 对应 Workspace API 未启用 | 在生产项目 API Library 启用报错中指出的 API |
| `access_denied` | 用户拒绝、Testing 未加入测试用户、Workspace 组织策略拦截 | 检查 Audience/Test users 和 Admin Console API Controls |
| `org_internal` | 应用错误配置为 Internal，外部账号无法访问 | 对外服务改为 External |
| Unverified app 警告 | Sensitive/Restricted scopes 未完成 verification | 完成 Branding 和 Data Access verification |
| 100-user cap | 应用申请未批准的 Sensitive/Restricted scopes | 完成验证；不能通过反复创建测试用户规避 |
| `invalid_grant` | token 被撤销、Testing token 过期、切换了 OAuth Client | 断开旧账号并使用生产 Client 重新授权 |
| 新配置仍出现旧 Client ID | user sandbox 中保留旧 `gogcli-client.json` | 断开账号、清理旧 user client 配置后重新授权 |
| 企业账号提示管理员阻止 | Workspace API Controls 禁止第三方应用 | 企业管理员按 Client ID 为指定 OU/Group 配置访问 |

## 7. 官方参考

- [创建 Google OAuth 凭据](https://developers.google.com/workspace/guides/create-credentials)
- [管理 Google Auth Platform Clients](https://support.google.com/cloud/answer/15549257?hl=en)
- [管理 Data Access scopes](https://support.google.com/cloud/answer/15549135?hl=en)
- [管理 App Audience](https://support.google.com/cloud/answer/15549945?hl=en)
- [提交 OAuth 应用验证](https://support.google.com/cloud/answer/13461325?hl=en)
- [OAuth 验证要求](https://support.google.com/cloud/answer/13464321?hl=en)
- [Restricted Scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google Workspace API 用户数据政策](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
