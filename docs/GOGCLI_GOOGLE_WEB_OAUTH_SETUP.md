# gogcli Google Web OAuth Client 配置流程

本文面向 ripple 服务端管理员，说明如何为 `gog` / Google Workspace 能力配置一次部署级 Google Web OAuth Client。

配置完成后，普通用户不需要提供 Google Cloud 凭据。每个 ripple `user_id` 只需要在浏览器打开一次授权 URL 并点击 Allow，refresh token 会加密保存在该 user 自己的 sandbox workspace 中。

## 当前授权范围

ripple 当前只保留基础 Google Workspace 服务：

```text
gmail,drive,calendar,docs,sheets,slides
```

对应需要启用的 Google API：

| 服务 | Google API service ID |
|---|---|
| Gmail | `gmail.googleapis.com` |
| Drive | `drive.googleapis.com` |
| Calendar | `calendar-json.googleapis.com` |
| Docs | `docs.googleapis.com` |
| Sheets | `sheets.googleapis.com` |
| Slides | `slides.googleapis.com` |

暂不配置 / 暂不授权：Tasks、People/Contacts、Classroom、Admin、Chat、Forms、Apps Script 等。

## 0. 准备信息

先确定 ripple 后端的浏览器可访问地址：

```text
https://<你的-ripple-api-domain>
```

例如：

```text
https://ripple.example.com
```

ripple 的 Google OAuth callback 固定是：

```text
https://<你的-ripple-api-domain>/v1/sandboxes/gogcli/oauth/callback
```

本地开发时可以使用：

```text
http://localhost:8810/v1/sandboxes/gogcli/oauth/callback
```

注意：Google OAuth Client 里的 Authorized redirect URI 必须和 ripple 实际发起授权时使用的 callback URL 完全一致，包括协议、域名、端口、路径和末尾斜杠。

## 1. 创建或选择 Google Cloud 项目

1. 打开 Google Cloud Console：<https://console.cloud.google.com/>
2. 顶部项目选择器中选择已有项目，或点击 `New Project` 新建项目。
3. 记录项目 ID，后面会填入 `config/settings.yaml` 的 `project_id`。

建议为 ripple 单独建一个项目，例如：

```text
ripple-google-workspace
```

## 2. 启用 Google Workspace APIs

### 方式 A：使用 Google Cloud Console

1. 打开 Google Cloud Console。
2. 进入 `APIs & Services` → `Library`。
3. 逐个搜索并启用：
   - Gmail API
   - Google Drive API
   - Google Calendar API
   - Google Docs API
   - Google Sheets API
   - Google Slides API
4. 每个 API 进入详情页后点击 `Enable`。

### 方式 B：使用 gcloud

如果本机已安装并登录 `gcloud`：

```bash
gcloud services enable \
  gmail.googleapis.com \
  drive.googleapis.com \
  calendar-json.googleapis.com \
  docs.googleapis.com \
  sheets.googleapis.com \
  slides.googleapis.com
```

## 3. 配置 OAuth consent screen / App audience

1. 进入 Google Cloud Console。
2. 打开 `Google Auth Platform`。
3. 进入 `Audience` 或 `OAuth consent screen` 页面。
4. 选择用户类型：
   - 只给同一个 Google Workspace / Cloud Identity 组织内部账号使用：选 `Internal`。
   - 要给普通 Gmail 或组织外 Google 账号使用：选 `External`。
5. 填写应用基础信息：
   - App name：例如 `Ripple`
   - User support email：选择管理员邮箱
   - Developer contact information：填写管理员邮箱
6. 保存。

如果选择 `External`，并且 Publishing status 还是 `Testing`：

1. 进入 `Test users`。
2. 点击 `Add users`。
3. 把需要授权的 Google 账号加入列表，例如：

```text
alice@gmail.com
bob@example.com
```

Testing 状态下，未加入 Test users 的账号不能稳定完成授权。长期对外使用时，应把应用发布到 Production，并根据 Google 要求完成 OAuth app verification。

如果测试账号没有加入 Test users，用户打开授权 URL 时通常会看到类似错误：

```text
禁止访问：“<应用名或域名>”尚未完成 Google 验证流程
此应用正在测试中，仅供已获开发者批准的测试人员使用。
错误 403：access_denied
```

这不是 ripple 或 gogcli 的错误，而是 Google OAuth consent 的访问控制。处理方式：

1. 回到 Google Auth Platform / OAuth consent screen。
2. 确认应用仍是 `External` + `Testing`。
3. 在 `Test users` 中加入当前授权使用的 Google 账号。
4. 保存后等待几分钟。
5. 回到 ripple 重新发起 `GoogleWorkspaceLoginStart`，使用新生成的 `oauth_url`，不要复用旧 URL。

## 4. 创建 Web OAuth Client

1. 进入 Google Cloud Console。
2. 打开 `Google Auth Platform` → `Clients`。
   - 旧入口也可能显示为 `APIs & Services` → `Credentials`。
3. 点击 `Create client` 或 `Create Credentials` → `OAuth client ID`。
4. Application type 选择：

```text
Web application
```

5. Name 填：

```text
ripple-gog
```

6. 找到 `Authorized redirect URIs`。
7. 点击 `Add URI`。
8. 填入 ripple callback URL：

```text
https://<你的-ripple-api-domain>/v1/sandboxes/gogcli/oauth/callback
```

例如：

```text
https://ripple.example.com/v1/sandboxes/gogcli/oauth/callback
```

本地开发示例：

```text
http://localhost:8810/v1/sandboxes/gogcli/oauth/callback
```

9. 点击 `Create`。
10. 复制生成的：
    - Client ID
    - Client secret

注意：Client secret 创建后只会完整显示一次。请保存到服务端私密配置或密钥管理系统中，不要发给普通用户，不要提交到 git。

## 5. 写入 ripple 配置

编辑 `config/settings.yaml`：

```yaml
server:
  public_base_url: "https://<你的-ripple-api-domain>"

  gogcli_oauth:
    auto_from_request: true
    auto_register_client: true
    callback_url: "https://<你的-ripple-api-domain>/v1/sandboxes/gogcli/oauth/callback"
    client:
      type: "web"
      client_id: "<GOOGLE_OAUTH_CLIENT_ID>.apps.googleusercontent.com"
      client_secret: "<GOOGLE_OAUTH_CLIENT_SECRET>"
      project_id: "<GCP_PROJECT_ID>"
```

本地开发示例：

```yaml
server:
  public_base_url: "http://localhost:8810"

  gogcli_oauth:
    auto_from_request: true
    auto_register_client: true
    callback_url: "http://localhost:8810/v1/sandboxes/gogcli/oauth/callback"
    client:
      type: "web"
      client_id: "<GOOGLE_OAUTH_CLIENT_ID>.apps.googleusercontent.com"
      client_secret: "<GOOGLE_OAUTH_CLIENT_SECRET>"
      project_id: "<GCP_PROJECT_ID>"
```

字段说明：

| 字段 | 作用 |
|---|---|
| `server.public_base_url` | 浏览器能访问到的 ripple API 根地址 |
| `server.gogcli_oauth.callback_url` | Google 回调到 ripple 的完整 URL |
| `server.gogcli_oauth.auto_register_client` | 允许 `GoogleWorkspaceLoginStart` 自动把部署级 OAuth Client 注册到当前 user |
| `server.gogcli_oauth.client.type` | 固定使用 `web` |
| `server.gogcli_oauth.client.client_id` | Google OAuth Client ID |
| `server.gogcli_oauth.client.client_secret` | Google OAuth Client secret |
| `server.gogcli_oauth.client.project_id` | Google Cloud project ID，主要用于生成标准 client_secret JSON 形状 |

## 6. 配置公网域名、nginx 和 HTTPS

生产 / 远程测试环境必须保证 Google 能通过公网 HTTPS 访问 ripple callback：

```text
https://<你的-ripple-api-domain>/v1/sandboxes/gogcli/oauth/callback
```

公网 IP 不写进 Google OAuth callback。正确链路是：

```text
Google / 用户浏览器
  -> https://<你的-ripple-api-domain>
  -> DNS 解析到服务器公网 IP
  -> nginx
  -> http://127.0.0.1:8810 ripple server
```

### 6.1 配置 DNS

让域名管理员把你的 callback 域名解析到 ripple 所在服务器：

```text
<你的-ripple-api-domain>  A  <服务器公网 IP>
```

如果域名已经能打到本机 nginx，这一步可以跳过。

### 6.2 先配置 HTTP 反向代理

先只配置 80 端口，确认 `/v1/` 能转发到 ripple 后端。示例：

```bash
sudo nano /etc/nginx/sites-available/<你的-ripple-api-domain>
```

写入：

```nginx
server {
    listen 80;
    server_name <你的-ripple-api-domain>;

    client_max_body_size 128m;

    location /v1/ {
        proxy_pass http://127.0.0.1:8810;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }

    location / {
        add_header Content-Type text/plain;
        return 200 "Ripple OAuth callback domain is alive\n";
    }
}
```

启用站点并 reload：

```bash
sudo ln -s /etc/nginx/sites-available/<你的-ripple-api-domain> /etc/nginx/sites-enabled/<你的-ripple-api-domain>
sudo nginx -t
sudo systemctl reload nginx
```

验证 HTTP：

```bash
curl -i http://<你的-ripple-api-domain>/v1/sandboxes/gogcli/oauth/callback
```

正确结果不是 404，而是 ripple 返回的 400 页面：

```text
HTTP/1.1 400 Bad Request
Google 授权失败
OAuth 回调缺少 state 参数。
```

这个 400 是正常的，因为手动访问时没有带 Google 回调需要的 `state` 和 `code`。

### 6.3 配置 HTTPS 证书

如果使用 certbot：

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <你的-ripple-api-domain>
```

如果别人给了 nginx 证书包，通常会包含：

```text
xxx_bundle.pem  # 证书链
xxx.key         # 私钥
```

先确认该证书覆盖 callback 域名：

```bash
openssl x509 -in xxx_bundle.pem -noout -subject -issuer -dates -ext subjectAltName
```

例如 `*.weilai.ai` 可以覆盖 `test-oauth.weilai.ai`。再确认私钥和证书匹配：

```bash
cert_hash=$(openssl x509 -noout -modulus -in xxx_bundle.pem | openssl md5)
key_hash=$(openssl rsa -noout -modulus -in xxx.key | openssl md5)
printf 'cert=%s\nkey=%s\nmatch=%s\n' "$cert_hash" "$key_hash" "$([ "$cert_hash" = "$key_hash" ] && echo yes || echo no)"
```

`match=yes` 才能继续。然后把证书放到 nginx 专用目录：

```bash
sudo mkdir -p /etc/nginx/ssl/<证书名>
sudo cp xxx_bundle.pem /etc/nginx/ssl/<证书名>/
sudo cp xxx.key /etc/nginx/ssl/<证书名>/
sudo chown root:root /etc/nginx/ssl/<证书名>/xxx_bundle.pem /etc/nginx/ssl/<证书名>/xxx.key
sudo chmod 644 /etc/nginx/ssl/<证书名>/xxx_bundle.pem
sudo chmod 600 /etc/nginx/ssl/<证书名>/xxx.key
```

### 6.4 完整 nginx HTTPS 示例

把站点配置改成：

```nginx
server {
    listen 80;
    server_name <你的-ripple-api-domain>;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name <你的-ripple-api-domain>;

    client_max_body_size 128m;

    ssl_certificate /etc/nginx/ssl/<证书名>/xxx_bundle.pem;
    ssl_certificate_key /etc/nginx/ssl/<证书名>/xxx.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    location /v1/ {
        proxy_pass http://127.0.0.1:8810;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }

    location / {
        add_header Content-Type text/plain;
        return 200 "Ripple OAuth callback domain is alive\n";
    }
}
```

检查并 reload：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

验证 HTTPS callback：

```bash
curl -i https://<你的-ripple-api-domain>/v1/sandboxes/gogcli/oauth/callback
```

正确结果仍然是 ripple 的 400 页面：

```text
HTTP/2 400
Google 授权失败
OAuth 回调缺少 state 参数。
```

如果看到 `404 Not Found`，说明 nginx 没有把 `/v1/` 转发到 ripple。  
如果看到证书域名不匹配，说明当前证书没有覆盖 `<你的-ripple-api-domain>`。

## 7. 重启 ripple server

```bash
uv run ripple
```

开发模式：

```bash
uv run ripple --reload
```

如果涉及网络访问，本项目约定先执行：

```bash
proxy_on
```

## 8. 为某个 ripple user 发起授权

假设 ripple `user_id` 是：

```text
alice
```

Google 账号是：

```text
alice@gmail.com
```

先确保当前 user sandbox 已创建：

```bash
curl -X POST "$API/v1/sandboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Ripple-User-Id: alice"
```

发起 Google 授权：

```bash
curl -X POST "$API/v1/tools/invoke" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Ripple-User-Id: alice" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "GoogleWorkspaceLoginStart",
    "args": {
      "email": "alice@gmail.com"
    }
  }'
```

返回结果中会包含：

```json
{
  "ok": true,
  "callback_mode": "assisted",
  "oauth_url": "https://accounts.google.com/o/oauth2/...",
  "email": "alice@gmail.com",
  "expires_in_seconds": 600
}
```

把 `oauth_url` 完整发给用户。用户需要：

1. 在浏览器打开 `oauth_url`。
2. 使用要绑定的 Google 账号登录。
3. 审查权限。
4. 点击 `Allow` / `允许`。
5. 浏览器显示 `Google 授权完成` 后回到 ripple。

assisted 模式下，ripple callback 会自动完成 step 2，并把 refresh token 写入当前 user 的 workspace：

```text
.ripple/sandboxes/<user_id>/workspace/.config/gogcli/keyring/
```

## 9. 验证授权结果

```bash
curl "$API/v1/connectors/google_workspace/accounts?check=true" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Ripple-User-Id: alice"
```

期望看到：

```json
{
  "has_client_config": true,
  "accounts": [
    {
      "email": "alice@gmail.com",
      "alias": null,
      "valid": true
    }
  ],
  "count": 1,
  "checked": true
}
```

如果 `valid` 是 `false`，通常表示 refresh token 已失效或被撤销，需要重新发起 `GoogleWorkspaceLoginStart`。

## 10. 授权后如何使用

后续请求只要使用相同的 ripple user：

```text
X-Ripple-User-Id: alice
```

agent 就会进入 `alice` 的 sandbox，使用已经保存的 gog token。

示例 gog 命令：

```bash
gog --account alice@gmail.com --json gmail search "newer_than:7d" --max 5
gog --account alice@gmail.com --json drive ls --max 20
gog --account alice@gmail.com --json calendar events primary --today
gog --account alice@gmail.com docs cat <docId>
gog --account alice@gmail.com --json sheets metadata <spreadsheetId>
gog --account alice@gmail.com --json slides info <presentationId>
```

每条命令都显式传 `--account <email>`，不要依赖 gog 的自动账号选择。

## 常见问题

### `GOGCLI_SERVER_OAUTH_CLIENT_REQUIRED`

服务端没有配置 `server.gogcli_oauth.client`，或配置为空。

处理：

1. 检查 `config/settings.yaml` 是否包含 `client_id` 和 `client_secret`。
2. 确认 ripple server 已重启并加载新配置。

### `redirect_uri_mismatch`

Google OAuth Client 的 Authorized redirect URI 与 ripple 实际使用的 callback URL 不一致。

处理：

1. 查看 `config/settings.yaml` 中的 `server.public_base_url` 和 `server.gogcli_oauth.callback_url`。
2. 在 Google Auth Platform → Clients → 当前 Web OAuth Client 中，把完全一致的 callback URL 加入 Authorized redirect URIs。
3. 重新发起 `GoogleWorkspaceLoginStart`。

### `access_denied` 或用户无法进入授权

常见原因：

- 用户点击了拒绝。
- External + Testing 状态下，用户没有加入 Test users。
- OAuth consent screen 配置不完整。
- 应用请求了 Gmail / Drive 等敏感或受限 scope，但还没有完成 Google verification。

处理：

1. 如果页面提示“此应用正在测试中，仅供已获开发者批准的测试人员使用”，进入 Google Auth Platform → Audience / OAuth consent screen → Test users，把该 Google 账号加入测试用户。
2. 保存后等待几分钟。
3. 重新发起 `GoogleWorkspaceLoginStart`，不要复用旧的 `oauth_url`。
4. 如果已经发布到 Production，但仍提示“尚未完成 Google 验证流程”，检查 OAuth verification 是否完成，以及当前请求的 scopes 是否已经通过验证。

### “尚未完成 Google 验证流程”是否可以直接发布 Production？

短期自用 / 小范围测试：

- 继续保持 `External` + `Testing`。
- 把每个要授权的 Google 账号加入 `Test users`。
- 注意 Testing 状态有测试用户数量限制，且测试授权可能过期，需要重新授权。

长期给外部用户使用：

1. 在 Google Auth Platform 中把应用发布到 `Production`。
2. 提交 OAuth app verification。
3. 只保留当前产品真实需要的最小 scopes。
4. 准备隐私政策、应用主页、权限使用说明、测试账号或演示材料。
5. 如果包含 restricted scopes，按 Google 要求完成更严格的 restricted scope verification。

ripple 当前 gog 基础服务会请求 Gmail / Drive / Calendar / Docs / Sheets / Slides 相关权限。其中 Gmail 和 Drive 的部分权限属于 restricted scopes，例如：

```text
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.settings.basic
https://www.googleapis.com/auth/gmail.settings.sharing
https://www.googleapis.com/auth/drive
```

这些权限公开给外部用户使用时，通常不能只靠切到 Production 解决，还需要通过 Google 的验证流程。

### 授权成功后业务命令报 `accessNotConfigured`

Google Cloud 项目没有启用对应 API。

处理：

1. 回到 Google Cloud Console → APIs & Services → Library。
2. 启用报错中提示的 API。
3. 等待几十秒后重试。

### Testing 状态授权过期

External + Testing 状态适合开发和小范围验证。Google 会限制 test users 数量，并且 test user 的授权会过期。

长期对外使用时，把应用发布到 Production，并按 Google 要求完成 OAuth app verification。

## 安全注意事项

- `client_secret` 是服务端密钥，只能放在服务端私密配置或密钥管理系统中。
- 不要把 `client_secret` 发给终端用户。
- 不要把真实 `config/settings.yaml` 提交到 git。
- `config/settings.yaml.sample` 只能保留占位符。
- 如果真实 secret 已经进入 git 历史或外部对话，请在 Google Cloud Console 里轮换 secret。

## 官方参考

- Enable Google Workspace APIs: <https://developers.google.com/workspace/guides/enable-apis>
- Manage OAuth Clients: <https://support.google.com/cloud/answer/6158849>
- Manage App Audience / Testing users: <https://support.google.com/cloud/answer/15549945>
- OAuth 2.0 Scopes for Google APIs: <https://developers.google.com/identity/protocols/oauth2/scopes>
- Restricted scopes: <https://support.google.com/cloud/answer/13464325>
- Sensitive scope verification: <https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification>
