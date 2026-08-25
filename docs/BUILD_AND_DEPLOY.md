# Ripple Build and Deploy

本文记录 Ripple 当前的启动、打包和部署流程。Ripple 后端是独立 Rust 服务，Web / macOS / iOS / Android 都只是客户端，统一调用 Ripple Server `/v1` API。

## 当前 API 地址

生产构建默认 API 暂时是：

```bash
http://140.143.229.103:8810/v1
```

这是 `test-oauth.weilai.ai` 被腾讯云备案/域名拦截期间的临时 HTTP IP 直连方案。恢复 HTTPS 域名后，需要同步回滚：

- `app/src/lib/api.ts` 的生产默认 API。
- `app/src-tauri/tauri.conf.json` 的 CSP。
- macOS / iOS 的 ATS 明文例外。
- Android `usesCleartextTraffic` 配置。
- 本文档中的临时地址说明。

如需临时覆盖前端 API 地址，构建时设置：

```bash
VITE_RIPPLE_API_URL="http://140.143.229.103:8810/v1" bun run build
```

## Web 启动

开发模式：

```bash
cd app
bun install
bun run dev
```

Web dev server 默认监听 `http://localhost:8820`。本地开发时，Vite 会把 `/v1` 代理到本机后端 `http://127.0.0.1:8810`。先从仓库根目录启动后端：

```bash
cargo run -p ripple-server
```

然后启动前端即可。若需要把 dev proxy 转发到其他后端，设置 `RIPPLE_VITE_PROXY_TARGET=http://<host>:<port>`；若要让浏览器绕过 proxy 直连后端，显式设置 `VITE_RIPPLE_API_URL=http://<host>:<port>/v1`。

生产静态构建：

```bash
cd app
bun install
bun run build
```

构建产物在：

```text
app/dist/
```

本地预览生产构建：

```bash
cd app
bun run preview
```

## macOS App 打包

前置要求：

- macOS。
- Xcode Command Line Tools。
- Rust toolchain。
- Bun。

打包命令：

```bash
cd app
bun install
bun run tauri:build
```

常用产物：

```text
app/src-tauri/target/release/bundle/macos/Ripple.app
app/src-tauri/target/release/bundle/dmg/Ripple_0.1.0_aarch64.dmg
```

如果只需要当前机器架构的 DMG，直接使用 `bun run tauri:build` 即可。需要 Intel / Apple Silicon 双架构分发时，先确认本机 Rust target 和 Tauri signing/notarization 配置，再分别构建或做 universal app。

验证：

```bash
cd app
bun run build
bun run tauri:build
```

打开 App 后如提示无法连接服务，先确认后端公网地址、端口 `8810`、API key 和当前临时 HTTP IP 配置是否一致。

## Android APK 打包

前置要求：

- JDK 17。
- Android SDK command line tools。
- Android platform / build-tools。
- Android NDK。
- Rust Android targets。

本机常用环境变量示例：

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/36.0.0:$PATH"
```

安装 SDK 组件示例：

```bash
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0" \
  "ndk;29.0.14206865"
```

构建 universal APK：

```bash
cd app
bun install
bun run tauri android build --apk --ci
```

Tauri 默认 release APK 产物是 unsigned：

```text
app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

直接安装测试时，可以用本机 debug keystore 签一个测试包：

```bash
cd app

zipalign -f -p 4 \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/Ripple-android-universal-release-aligned.apk

apksigner sign \
  --ks "$HOME/.android/debug.keystore" \
  --ks-key-alias androiddebugkey \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out src-tauri/gen/android/app/build/outputs/apk/universal/release/Ripple-android-universal-release-debugsigned.apk \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/Ripple-android-universal-release-aligned.apk
```

验证签名和安装：

```bash
cd app

apksigner verify --verbose --print-certs \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/Ripple-android-universal-release-debugsigned.apk

zipalign -c -p 4 \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/Ripple-android-universal-release-debugsigned.apk

adb install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/Ripple-android-universal-release-debugsigned.apk
```

发布到应用市场时不要使用 debug keystore，要改用正式 release keystore 签名。

## iOS App 打包

前置要求：

- macOS。
- Xcode。
- Apple Developer 账号。
- 已配置 signing certificate、provisioning profile、App Store Connect app。
- Bundle ID 与 Tauri identifier 保持一致：`com.viaim.ripple`。

首次初始化：

```bash
cd app
bun install
bun run tauri:ios:init
```

真机开发调试：

```bash
cd app
bun run tauri ios dev --host <LAN_IP>
```

`<LAN_IP>` 必须是 iPhone 能访问到的 Mac 局域网 IP。不要在真机上依赖 `localhost` 访问后端。

TestFlight / App Store Connect 构建：

```bash
cd app
bun run tauri:ios:build:testflight -- --build-number 1
```

常见 IPA 产物位置：

```text
app/src-tauri/gen/apple/build/arm64/Ripple.ipa
```

上传 App Store Connect：

```bash
xcrun altool --upload-app \
  --type ios \
  --file "src-tauri/gen/apple/build/arm64/Ripple.ipa" \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_ISSUER"
```

更多移动端注意事项见 [TAURI_MOBILE.md](TAURI_MOBILE.md)。

## 后端本地启动

准备配置：

```bash
cp config/settings.yaml.sample config/settings.yaml
```

至少修改：

- `server.api_keys`：可信上游服务调用 Ripple 的服务级 API key。
- `server.user_auth`：仅用于开发/内测阶段的浏览器邀请制登录；生产部署默认关闭。
- `server.host` / `server.port`：监听地址和端口，默认 `0.0.0.0:8810`。
- `server.sandbox.workspaces_root`：生产如需把用户 workspace 放到独立磁盘或 NAS，在这里配置。
- `external_agents.codex.codex_home`：服务端 Codex provider 配置目录。
- `external_agents.codex.max_workers_per_pool` / `max_total_pool_workers`：Codex app-server worker pool 上限。
- connector OAuth 配置，例如 Google Workspace / Feishu。Google Workspace 生产 Client 的企业管理员申请、授权和交付流程见 [GOOGLE_WORKSPACE_PRODUCTION_OAUTH_ADMIN_GUIDE.md](GOOGLE_WORKSPACE_PRODUCTION_OAUTH_ADMIN_GUIDE.md)。

国内生产部署统一使用百炼 Token Plan，通过 Codex app-server 的自定义
`model_provider` 直接调用 Responses-compatible endpoint。密钥只从 root-only
进程环境注入，不使用 OpenAI 登录态或多账号代理。

准备百炼进程环境：

```bash
install -d -m 700 /root/.config/ripple
install -m 600 /dev/null /root/.config/ripple/bailian-token-plan.env
# 写入 BAILIAN_API_KEY=<百炼 Token Plan key>，不要把值写入仓库。
set -a
. /root/.config/ripple/bailian-token-plan.env
set +a
```

启动后端：

```bash
cargo run -p ripple-server
```

指定配置文件：

```bash
RIPPLE_CONFIG=/absolute/path/to/settings.yaml cargo run -p ripple-server
```

健康检查：

```bash
curl -fsS http://127.0.0.1:8810/health
```

带鉴权检查模型接口：

```bash
curl -fsS \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  -H "X-Ripple-User-Id: default" \
  http://127.0.0.1:8810/v1/models
```

`/v1/models` 会读取 Codex app-server 的 runtime model catalog，并合并 Ripple 现有 preset。这里不做 preset fallback；如果 runtime 模型目录不可用，应先修复 Codex app-server、百炼 provider 配置或密钥注入链路。

## 后端打包

构建 release binary：

```bash
cargo build --release -p ripple-server
```

产物：

```text
target/release/ripple-server
```

打一个简单 tar 包：

```bash
rm -rf dist/ripple-server
mkdir -p dist/ripple-server/config dist/ripple-server/scripts
cp target/release/ripple-server dist/ripple-server/
cp config/settings.yaml.sample dist/ripple-server/config/
cp scripts/install-feishu-cli.sh scripts/install-notion-cli.sh scripts/install-gogcli-cli.sh scripts/install-bilibili-cli.sh scripts/install-podcast-cli.sh dist/ripple-server/scripts/
cp -R skills dist/ripple-server/
tar -C dist -czf "ripple-server-$(uname -s)-$(uname -m).tar.gz" ripple-server
```

部署机器上解包后，把示例配置复制成真实配置：

```bash
cp config/settings.yaml.sample config/settings.yaml
```

不要把真实 `config/settings.yaml`、API key、OAuth credential、Codex auth 或 `.ripple/` 打进包里。

如果不随包携带 `skills`，需要在部署配置中把 `skills.shared_dirs` 指向服务器上的真实 shared skills 目录。

## 后端部署

本节是新 Linux 机器部署 `ripple-server` 的完整 runbook。目标是只读本文，就能把后端服务启动起来，并让 Codex app-server 通过百炼 Token Plan 运行。

生产主线固定为：

```text
Browser / App
    |
Trusted Web / Reverse Proxy
    | injects X-Ripple-User-Id, strips spoofed user headers
Ripple Server :8810
    |
official Codex app-server
    |
百炼 Token Plan Responses endpoint
```

生产环境不使用 `server.user_auth` 的轻量邀请码登录。该能力只用于开发、内测或没有上游用户系统时的临时验证。生产调用方由可信上游完成用户认证，注入 `X-Ripple-User-Id`，并使用服务级 API key 调用 Ripple。

命令默认由 `root` 或有 `sudo` 权限的部署用户执行。示例路径：

```text
/opt/ripple                         # Ripple 发布包或代码目录
/nas/ripple-data                    # 持久数据根目录；没有 NAS 时可替换成 /data/ripple-data
/nas/ripple-data/ripple-runtime     # Ripple SQLite/runtime
/nas/ripple-data/sandboxes          # 用户 workspace 和 credentials
/nas/ripple-data/sandboxes-cache    # shared cache
/nas/ripple-data/codex-service-home # 服务端 Codex home
/nas/ripple-data/codex-runtime      # per-user Codex runtime home/sqlite
```

### 部署依赖分层

| 能力 | 必要依赖 |
| --- | --- |
| HTTP 服务启动和 `/health` | `ripple-server` binary、配置文件、可写 runtime 目录 |
| `/v1/health/ready` | SQLite/runtime 目录、`external_agents.codex.codex_executable` 可解析 |
| 第一次 Codex 请求 | official Codex CLI、百炼 provider 配置、`BAILIAN_API_KEY`、`bubblewrap`/`bwrap` |
| Python helper / executable skill | `python3`、`uv`、可写 `python_envs_root` 和 `python_env_uv_cache` |
| Node/npm 任务 | Node.js `>=18.17.0`、`npm` |
| connector auth/status flow | `nsjail`、对应 connector CLI：`lark-cli`、`gog`、`ntn` 等 |
| Office 文件预览 | LibreOffice 的 `soffice` |

`/health` 活着不代表真实 Codex 请求能跑。Codex worker 启动前会做 `bwrap` sandbox probe，失败会 fail closed。`nsjail` 主要用于 connector CLI 和 doctor 检查；生产建议一起装好。

### 安装系统依赖

Ubuntu / Debian：

```bash
apt-get update
apt-get install -y \
  bash ca-certificates coreutils curl git grep jq procps rsync tar unzip xz-utils \
  gnupg lsb-release \
  build-essential pkg-config libssl-dev libsqlite3-dev \
  python3 python3-venv python3-pip \
  bubblewrap \
  libreoffice fonts-noto-cjk fonts-wqy-zenhei fonts-wqy-microhei fonts-dejavu fonts-liberation
```

检查 `bwrap`：

```bash
command -v bwrap
bwrap --version || bwrap --help
bwrap --ro-bind / / --proc /proc --dev /dev --unshare-user --unshare-pid -- /bin/true
```

如果系统禁用了 unprivileged user namespace，`bwrap` 和 `nsjail` 的 user namespace probe 会失败。先检查：

```bash
sysctl kernel.unprivileged_userns_clone || true
sysctl user.max_user_namespaces || true
```

如需开启：

```bash
cat >/etc/sysctl.d/99-ripple-sandbox.conf <<'EOF'
kernel.unprivileged_userns_clone=1
EOF
sysctl --system
```

### 安装 Node.js 和 uv

前端构建和部分 connector 工具要求较新的 Node.js。Ubuntu 22.04 默认仓库里的 `nodejs` 可能太旧，推荐装 Node.js 20：

```bash
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 18 || (major === 18 && minor >= 17) ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

node --version
npm --version
```

安装 `uv`，供 Python helper / executable skill 创建环境：

```bash
curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="/usr/local/bin" sh
command -v uv
uv --version
```

### 安装 Rust

如果部署的是已经构建好的 release binary，可以跳过 Rust。要在目标机器从源码构建 Ripple 或 repo-local connector CLI，则安装 Rust：

```bash
curl https://sh.rustup.rs -sSf | sh -s -- -y
. "$HOME/.cargo/env"
rustc --version
cargo --version
```

`crates/ripple-server` 当前 MSRV 是 Rust `1.77.2`，新版本 stable Rust 也可以构建。

### 安装 nsjail

先尝试系统包：

```bash
apt-cache policy nsjail || true
if apt-cache show nsjail >/dev/null 2>&1; then
  apt-get install -y nsjail
fi
```

如果系统仓库没有 `nsjail`，从源码构建：

```bash
apt-get install -y bison flex libprotobuf-dev protobuf-compiler libcap-dev

rm -rf /opt/nsjail
git clone --depth 1 https://github.com/google/nsjail.git /opt/nsjail
cd /opt/nsjail

cat >>missing_defs.h <<'EOF'

#if !defined(PR_SCHED_CORE)
#define PR_SCHED_CORE 62
#endif

#if !defined(PR_SCHED_CORE_CREATE)
#define PR_SCHED_CORE_CREATE 1
#endif

#if !defined(PR_SCHED_CORE_SCOPE_THREAD_GROUP)
#define PR_SCHED_CORE_SCOPE_THREAD_GROUP 1
#endif
EOF

PKG_CONFIG_PATH= \
PKG_CONFIG_LIBDIR=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
make -j"$(nproc)"

install -m 0755 nsjail /usr/local/bin/nsjail
```

验证：

```bash
command -v nsjail
nsjail -h | head
nsjail -Q -Mo --chroot / -- /bin/true
```

如果源码构建时出现 protobuf header/API 不匹配，通常是 `PKG_CONFIG_PATH` 指到了机器上其他 protobuf 安装，例如 Mellanox/grpc。继续用上面的 `PKG_CONFIG_PATH=` 和 `PKG_CONFIG_LIBDIR=...` 强制使用系统 protobuf。

### 安装 official Codex CLI

安装 official Codex CLI：

```bash
npm install -g @openai/codex
which codex
codex --version
```

生产配置中的 `external_agents.codex.codex_executable` 应填写上一步得到的稳定绝对路径。
更新 Codex CLI 后，先验证版本和百炼链路，再切换生产路径。

### 放置 Ripple 发布包

如果用 release 包：

```bash
rm -rf /opt/ripple
mkdir -p /opt/ripple
tar -C /opt/ripple --strip-components=1 -xzf ripple-server-Linux-x86_64.tar.gz
cd /opt/ripple
chmod +x ./ripple-server
cp config/settings.yaml.sample config/settings.yaml
```

如果在目标机器源码构建：

```bash
git clone <RIPPLE_REPO_URL> /opt/ripple
cd /opt/ripple
cargo build --release -p ripple-server
cp target/release/ripple-server /opt/ripple/ripple-server
cp config/settings.yaml.sample config/settings.yaml
```

### 创建持久数据目录

```bash
export RIPPLE_DATA_ROOT=/nas/ripple-data

mkdir -p "$RIPPLE_DATA_ROOT/ripple-runtime"
mkdir -p "$RIPPLE_DATA_ROOT/sandboxes"
mkdir -p "$RIPPLE_DATA_ROOT/sandboxes-cache"
mkdir -p "$RIPPLE_DATA_ROOT/codex-service-home"
mkdir -p "$RIPPLE_DATA_ROOT/codex-runtime"

chmod 700 "$RIPPLE_DATA_ROOT/codex-service-home"

cd /opt/ripple
ln -sfn "$RIPPLE_DATA_ROOT/ripple-runtime" .ripple
```

### 配置百炼 Token Plan

国内部署不登录 OpenAI，也不创建 `auth.json`。在服务端 Codex home 写入百炼 provider：

```toml
model = "qwen3.7-plus"
model_provider = "Model_Studio_Token_Plan"
model_supports_reasoning_summaries = true
model_reasoning_effort = "medium"

[model_providers.Model_Studio_Token_Plan]
name = "Model_Studio_Token_Plan"
base_url = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
env_key = "BAILIAN_API_KEY"
wire_api = "responses"
```

文件保存为 `/nas/ripple-data/codex-service-home/config.toml`，权限设为 `600`。
密钥单独保存在仓库外：

```bash
install -d -m 700 /root/.config/ripple
install -m 600 /dev/null /root/.config/ripple/bailian-token-plan.env
# 写入 BAILIAN_API_KEY=<百炼 Token Plan key>
```

### 配置 settings.yaml

`/opt/ripple/config/settings.yaml` 至少要包含以下关键配置。API key、OAuth client、CORS 等按实际部署补齐。

```yaml
external_agents:
  codex:
    enabled: true
    codex_executable: "/usr/local/bin/codex"
    app_server_args: ["app-server", "--listen", "stdio://"]
    provider_env_keys: ["BAILIAN_API_KEY"]
    requires_service_auth: false
    codex_home: "/nas/ripple-data/codex-service-home"
    approval_policy:
      granular:
        sandbox_approval: true
        rules: false
        skill_approval: false
        request_permissions: true
        mcp_elicitations: false
    sandbox_type: "workspace-write"
    network_access: true
    max_workers_per_pool: 50
    max_total_pool_workers: 256
    idle_timeout_seconds: 1800
    runtime_log_retention_seconds: 86400
    runtime_log_max_mb: 64
    runtime_log_cleanup_interval_seconds: 3600

server:
  host: "0.0.0.0"
  port: 8810
  security:
    deployment_mode: "trusted-proxy"
    require_confirm_for_risky_api: true
    require_https: false
  user_auth:
    enabled: false
    session_ttl_seconds: 2592000
  cors:
    allowed_origins: []
    allow_any_origin: false
  sandbox:
    sandboxes_root: "/nas/ripple-data/sandboxes"
    workspaces_root: "/nas/ripple-data/sandboxes"
    caches_root: "/nas/ripple-data/sandboxes-cache"
    python_envs_root: "/nas/ripple-data/sandboxes-cache/python-envs"
    python_env_uv_cache: "/nas/ripple-data/sandboxes-cache/uv-cache"
  document_preview:
    cache_root: "/nas/ripple-data/sandboxes-cache/previews"
    libreoffice_path: "soffice"
```

关键点：

- `codex_executable` 使用 official Codex CLI 的稳定绝对路径。
- `codex_home` 指向只包含百炼 provider 配置的服务端专用 Codex home。
- `provider_env_keys` 只声明变量名；密钥值由服务管理器从 root-only 文件注入。
- `requires_service_auth: false` 禁止继续依赖 OpenAI `auth.json`。
- `server.security.deployment_mode` 保持 `trusted-proxy`，由上游注入可信 `X-Ripple-User-Id`。
- `server.user_auth.enabled` 生产保持 `false`。轻量邀请码登录只用于开发/内测。
- `server.cors.allowed_origins` 生产只填明确 origin，不使用 `allow_any_origin`。

### 运行边界

Ripple 是控制面，Codex app-server 是服务端受信执行面宿主进程：

- Codex app-server 不运行在 user `nsjail` 内；Codex shell 命令由 Codex Linux sandbox / `bwrap` 和 Ripple managed permissions profile 约束。
- Connector CLI auth/status flow 通过 `nsjail` 和 per-user credentials 运行，要求 runtime probe 通过。
- user workspace 隔离单位是 `user_id`，同一 user 的多个 session 共享长期 workspace。
- Codex sandbox probe 或 connector `nsjail` probe 失败时按 fail-closed 处理，不静默降级执行。
- 不要把服务端 `CODEX_HOME/auth.json` 复制、挂载或保存到 `/nas/ripple-data/sandboxes/<user_id>/workspace/`。

### 开发/内测轻量登录

生产不要启用 `server.user_auth`。如果开发或内测阶段暂时没有上游用户系统，可以开启轻量邀请登录：

```yaml
server:
  user_auth:
    enabled: true
    session_ttl_seconds: 2592000
```

管理命令：

```bash
cd /opt/ripple

./ripple-server auth create-invite --max-uses 1 --expires-days 14 --config config/settings.yaml
./ripple-server auth list-users --config config/settings.yaml
./ripple-server auth disable-user <login-or-user-id> --config config/settings.yaml
./ripple-server auth revoke-sessions <login-or-user-id> --config config/settings.yaml
```

这些命令只读写 SQLite 管理数据，不会启动 HTTP 服务，也不会影响正在运行的服务进程。

### 安装 connector CLI

如需 connectors，安装对应 CLI：

```bash
bash scripts/install-feishu-cli.sh
bash scripts/install-notion-cli.sh
bash scripts/install-gogcli-cli.sh
bash scripts/install-bilibili-cli.sh
bash scripts/install-podcast-cli.sh
```

这些脚本会把 CLI 装到项目内 `vendor/`，配置加载时会自动发现 `vendor/lark-cli`、`vendor/notion-cli`、`vendor/gogcli-cli`。Bilibili / podcast 这类通用 CLI 需要在 `server.sandbox.cli_tools` 中配置或使用示例配置里的对应段落。

### 启动服务

```bash
cd /opt/ripple
RIPPLE_CONFIG=/opt/ripple/config/settings.yaml ./ripple-server
```

systemd service 示例：

```ini
[Unit]
Description=Ripple Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ripple
Environment=RIPPLE_CONFIG=/opt/ripple/config/settings.yaml
Environment=RUST_LOG=info
EnvironmentFile=/root/.config/ripple/bailian-token-plan.env
ExecStart=/opt/ripple/ripple-server
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

### 部署后验收

基础二进制：

```bash
test -x /opt/ripple/ripple-server
command -v bwrap
command -v nsjail
command -v python3
command -v uv
command -v node
command -v npm
command -v soffice
command -v codex
```

版本和 sandbox probe：

```bash
node --version
npm --version
uv --version
codex --version
nsjail -Q -Mo --chroot / -- /bin/true
bwrap --ro-bind / / --proc /proc --dev /dev --unshare-user --unshare-pid -- /bin/true
```

HTTP 和 readiness：

```bash
curl -fsS http://127.0.0.1:8810/health

curl -fsS \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  http://127.0.0.1:8810/v1/health/ready

cd /opt/ripple
./ripple-server doctor --config /opt/ripple/config/settings.yaml
```

触发一次 Codex 请求后，验证进程链：

```bash
ps -eo pid,ppid,cmd \
  | grep -E 'ripple-server|codex.*app-server' \
  | grep -v grep
```

期望看到类似：

```text
ripple-server
/usr/local/bin/codex app-server --listen stdio:// ...
```

检查 provider 配置和 per-user runtime 链接：

```bash
grep -E '^(model|model_provider|base_url|env_key|wire_api)' \
  /nas/ripple-data/codex-service-home/config.toml
find /nas/ripple-data/codex-runtime/users -maxdepth 4 -name config.toml -printf '%p -> %l\n'
```

期望：

- provider 是 `Model_Studio_Token_Plan`，endpoint 指向阿里百炼 Token Plan。
- `env_key` 是 `BAILIAN_API_KEY`，配置文件内没有真实密钥。
- user runtime 下的 `codex-home/config.toml` 指向服务端 provider 配置。

如果前端从公网访问后端，需要确认：

- 云安全组和防火墙放通 `8810` 或反向代理端口。
- `server.public_base_url` 配成浏览器可访问的公网地址。
- OAuth provider 的 callback URL 与 `server.public_base_url` 匹配。
- 当前 HTTP IP 过渡期客户端允许明文 HTTP；恢复 HTTPS 后移除明文例外。

### 运行时日志清理

Codex 自身会写入 `logs_2.sqlite`，主要是 trace/debug 级运行时日志。它不参与 Ripple 会话列表、消息恢复或 Codex thread 续聊；当前部署中前两者依赖本机 `.ripple/ripple.sqlite`、`.ripple/codex-sqlite/**/state_5.sqlite`，thread rollout 文件仍在 user runtime 中。

Ripple Server 启动后会按配置自动清理这些日志库：

- `/root/ripple/.ripple/codex-sqlite/users/<user_id>/sqlite/logs_2.sqlite`
- `/nas/ripple-data/sandboxes/<user_id>/codex-home/logs_2.sqlite`，仅兼容旧布局
- `/nas/ripple-data/codex-service-home/logs_2.sqlite`

默认策略：

- 删除超过 `runtime_log_retention_seconds` 的旧日志。
- 执行 SQLite checkpoint 和 `VACUUM` 缩小文件。
- 如果单个日志库仍超过 `runtime_log_max_mb`，清空 `logs` 表并再次 `VACUUM`。
- 如果日志库正被 Codex 写入导致短暂锁冲突，本轮跳过，下个周期重试。

不要把下面这些路径当成普通日志清理：

- `/root/ripple/.ripple/ripple.sqlite*`
- `/root/ripple/.ripple/codex-sqlite/users/<user_id>/sqlite/state_5.sqlite`
- `/nas/ripple-data/sandboxes/<user_id>/codex-home/sessions`
- `/nas/ripple-data/sandboxes/<user_id>/sessions`

### 文件预览运行时

Workspace 文件预览里，PDF 会直接以内联 PDF 返回；Word、Excel、PowerPoint 等 Office 文件会先通过 LibreOffice 的 `soffice` 转成 PDF，再返回给前端只读查看。

安装系统依赖时已经包含 `libreoffice` 和常用中文字体。部署后检查：

```bash
command -v soffice
soffice --version
```

如果生产环境里 `soffice` 不在服务进程 `PATH` 里，在 `config/settings.yaml` 显式指定：

```yaml
server:
  document_preview:
    libreoffice_path: "/usr/bin/soffice"
```

只安装 LibreOffice 通常不需要重启 `ripple-server`。修改 `config/settings.yaml` 后需要重启。

### 备份与升级

当前部署的自动备份只覆盖本机运行时，不二次复制 NAS 上已有的 sandbox、workspace、credentials、agent-runs 或 service auth。备份过程不停服务：脚本使用 SQLite `.backup` 创建一致性逻辑快照，随后校验、压缩并发布到 NAS。

自动备份范围：

- `/root/ripple/.ripple/ripple.sqlite` 和 `.ripple/audit.jsonl`：每 15 分钟。
- `/root/ripple/.ripple/codex-sqlite/**/{state_5,goals_1,memories_1}.sqlite`：每日一次。

不备份：

- `logs_2.sqlite`。
- `/nas/ripple-data/**` 的现有业务数据。
- `sandboxes-cache`。

快照在 `/nas/ripple-data/backups/ripple-local/` 保留 7 天。不得直接复制在线的 `ripple.sqlite`、`ripple.sqlite-wal` 和 `ripple.sqlite-shm`；安装与恢复命令见 [本地 SQLite 迁移](LOCAL_SQLITE_MIGRATION.md#备份与恢复)。

升级前先备份，再替换 `/opt/ripple/ripple-server` 和配置。当前版本会把可重放的 `queued/running` job 保存在原 SQLite 中；新进程启动时自动恢复并重新派发，最多自动重试一次。旧版本生成、缺少 replay envelope 的运行中记录仍会标记为 `interrupted_by_restart`。Run output 下载使用 `/v1/runs/:job_id/output`，不要依赖 host path。

单实例不停任务升级按下面顺序执行。该流程不会搬迁或复制 NAS 数据，也不能同时启动两个写同一 SQLite 的 `ripple-server`：

```bash
# 1. 先把新二进制放到临时名称
install -m 0755 ./target/release/ripple-server /opt/ripple/ripple-server.next

# 2. 旧进程进入 drain：新任务只入 queued，定时任务停止派发，readiness 返回 503
curl -fsS -X POST \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  http://127.0.0.1:8810/v1/internal/drain

# 3. 查看运行中任务；active_jobs 归零后切换最快
curl -fsS \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  http://127.0.0.1:8810/v1/internal/drain/status

# 4. 保持单实例，停止旧进程、替换二进制、启动新进程
systemctl stop ripple-server
install -m 0755 /opt/ripple/ripple-server.next /opt/ripple/ripple-server
systemctl start ripple-server

# 5. 验收新进程
curl -fsS http://127.0.0.1:8810/health
curl -fsS \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  http://127.0.0.1:8810/v1/health/ready
```

如果 30 秒内仍有运行中 job，服务会退出，但其执行参数和 attempt 已持久化；新进程会从 NAS 上的同一 SQLite 恢复。这个方案提供的是“任务不丢、允许最多一次重放”，不是任意外部副作用的 exactly-once 保证。

本仓库提供 `scripts/backup-ripple-runtime-to-nas.sh` 及两个 systemd timer：控制面每 15 分钟、Codex 状态每日一次。它们已固定当前部署路径 `/root/ripple/.ripple`；如部署路径变化，必须在安装前显式更新 unit 的环境变量。

### 诊断入口

HTTP doctor：

```bash
curl -fsS \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  http://127.0.0.1:8810/v1/diagnostics/doctor
```

CLI doctor：

```bash
cd /opt/ripple
./ripple-server doctor --config /opt/ripple/config/settings.yaml
```

Doctor 会检查 SQLite、目录权限、Codex executable、`bwrap` / Codex Linux sandbox probe、`nsjail` config/runtime probe、connector CLI、CORS 和 trusted-proxy 姿态。

### 常见部署故障

Ripple 请求超时但 `/health` 正常时，优先检查 worker 启动链：

```bash
ps -eo pid,ppid,cmd | grep -E 'codex.*app-server' | grep -v grep
journalctl -u ripple-server -n 200 --no-pager
```

常见原因：

- `external_agents.codex.codex_executable` 指向不存在的路径。
- `app_server_args` 里出现空字符串或顺序错误。
- 服务进程没有加载 `BAILIAN_API_KEY`，或 provider 的 `env_key` 名称不一致。
- 服务端 `codex_home/config.toml` 没有声明百炼 provider。
- `bwrap` 或 user namespace probe 失败。

只检查密钥是否存在，不要把密钥值输出到日志：

```bash
set -a
. /root/.config/ripple/bailian-token-plan.env
set +a
test -n "$BAILIAN_API_KEY"
```

修改配置后没有生效时，重启 Ripple Server。必要时在维护窗口确认旧 worker 已退出：

```bash
pkill -f '/usr/local/bin/codex app-server' || true
```

### 换机器迁移

旧机器：

```bash
systemctl stop ripple-server
rsync -aH --numeric-ids /nas/ripple-data/ new-host:/nas/ripple-data/
rsync -aH --numeric-ids /opt/ripple/ new-host:/opt/ripple/
```

新机器：

```bash
npm install -g @openai/codex

cd /opt/ripple
ln -sfn /nas/ripple-data/ripple-runtime .ripple
RIPPLE_CONFIG=/opt/ripple/config/settings.yaml ./ripple-server
```

密钥文件位于仓库和 NAS 数据目录之外，需要通过单独的密钥管理流程迁移到
`/root/.config/ripple/bailian-token-plan.env` 并保持 `600` 权限。不要把它放入 rsync 的普通发布包。

## 后端验证命令

常规验证：

```bash
cargo fmt -p ripple-server
cargo check -p ripple-server
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
```

旧控制面文件状态迁移到 SQLite：

```bash
target/release/ripple-server migrate-files-to-sqlite --config config/settings.yaml
```

## 提交前检查

前端 / App：

```bash
cd app
bun run lint
bun run build
```

后端：

```bash
cargo fmt -p ripple-server
cargo check -p ripple-server
```

按风险补充：

```bash
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
```
