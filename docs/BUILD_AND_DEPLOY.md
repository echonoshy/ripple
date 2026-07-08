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

Web dev server 默认监听 `http://localhost:8820`。本地开发时，Vite 会把 `/v1` 代理到当前临时公网服务端 `http://140.143.229.103:8810`。如需改回本机后端，先从仓库根目录启动后端：

```bash
cargo run -p ripple-server
```

然后显式设置 `VITE_RIPPLE_API_URL=http://127.0.0.1:8810/v1` 启动前端，或调整 Vite proxy。

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
- `external_agents.codex.codex_home`：服务端 Codex 登录态目录。
- `external_agents.codex.max_workers_per_pool` / `max_total_pool_workers`：Codex app-server worker pool 上限。
- connector OAuth 配置，例如 Google Workspace / Feishu。

生产部署统一通过 `codex-multi-auth` 启动 Codex app-server，并使用多 Codex 账号池做 runtime rotation，按本文后面的“后端部署”章节配置。

登录服务端 Codex：

```bash
CODEX_HOME=.ripple/codex-service-home codex login
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

本节是新 Linux 机器部署 `ripple-server` 的完整 runbook。目标是只读本文，就能把后端服务启动起来，并让 Codex app-server 通过 `codex-multi-auth` 多账号池运行。

生产主线固定为：

```text
Browser / App
    |
Trusted Web / Reverse Proxy
    | injects X-Ripple-User-Id, strips spoofed user headers
Ripple Server :8810
    |
codex-multi-auth-codex
    |
official Codex app-server
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
/nas/ripple-data/codex-multi-auth   # codex-multi-auth 账号池和运行时状态
```

### 部署依赖分层

| 能力 | 必要依赖 |
| --- | --- |
| HTTP 服务启动和 `/health` | `ripple-server` binary、配置文件、可写 runtime 目录 |
| `/v1/health/ready` | SQLite/runtime 目录、`external_agents.codex.codex_executable` 可解析 |
| 第一次 Codex 请求 | official Codex CLI、`codex-multi-auth-codex`、真实 `codex-real-*`、`bubblewrap`/`bwrap`、服务端 `CODEX_HOME/auth.json` |
| Python helper / executable skill | `python3`、`uv`、可写 `python_envs_root` 和 `python_env_uv_cache` |
| Node/npm 任务和 `codex-multi-auth` | Node.js `>=18.17.0`、`npm` |
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

`codex-multi-auth@2.3.3` 要求 Node.js `>=18.17.0`。Ubuntu 22.04 默认仓库里的 `nodejs` 可能太旧，推荐装 Node.js 20：

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

### 安装 official Codex CLI 和 codex-multi-auth

安装 official Codex CLI：

```bash
npm install -g @openai/codex
which codex
codex --version
```

把当前 official Codex CLI 固定成一个真实 CLI 入口路径，供 `codex-multi-auth` 包装器转发：

```bash
REAL_CODEX_BIN="$(readlink -f "$(which codex)")"
ln -sf "$REAL_CODEX_BIN" /usr/bin/codex-real-0.142.5
/usr/bin/codex-real-0.142.5 --version
```

版本号 `0.142.5` 是当前线上验证过的命名示例。换版本时，同步改 symlink 名字和 `settings.yaml` 里的 `CODEX_MULTI_AUTH_REAL_CODEX_BIN`。

安装 `codex-multi-auth`：

```bash
npm install -g codex-multi-auth@2.3.3
which codex-multi-auth
which codex-multi-auth-codex
codex-multi-auth --version
codex-multi-auth-codex --version
```

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
mkdir -p "$RIPPLE_DATA_ROOT/codex-multi-auth"

chmod 700 "$RIPPLE_DATA_ROOT/codex-service-home"
chmod 700 "$RIPPLE_DATA_ROOT/codex-multi-auth"

cd /opt/ripple
ln -sfn "$RIPPLE_DATA_ROOT/ripple-runtime" .ripple
```

### 登录服务端 Codex 和 multi-auth 账号池

Ripple 每个 user 的 Codex runtime home 会通过 symlink 引用服务端 `codex-service-home/auth.json`。先登录一次服务端专用 Codex home：

```bash
CODEX_HOME=/nas/ripple-data/codex-service-home codex login --device-auth
test -f /nas/ripple-data/codex-service-home/auth.json
```

再登录 `codex-multi-auth` 账号池。需要几个账号就重复几次 `login`：

```bash
export CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth

codex-multi-auth login --device-auth
codex-multi-auth login --device-auth
codex-multi-auth list
codex-multi-auth status
codex-multi-auth check
codex-multi-auth forecast --live
```

常用账号管理命令：

```bash
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth list
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth switch 2
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth unpin
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth best --live
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth rotation status
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth report --live --json
```

### 配置 settings.yaml

`/opt/ripple/config/settings.yaml` 至少要包含以下关键配置。API key、OAuth client、CORS 等按实际部署补齐。

```yaml
external_agents:
  codex:
    enabled: true
    codex_executable: "/usr/bin/env"
    app_server_args:
      - "CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth"
      - "CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1"
      - "CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0"
      - "CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP=0"
      - "CODEX_AUTH_PER_PROJECT_ACCOUNTS=0"
      - "CODEX_MULTI_AUTH_APP_BIND_INSTALL=0"
      - "CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0"
      - "CODEX_MULTI_AUTH_REAL_CODEX_BIN=/usr/bin/codex-real-0.142.5"
      - "codex-multi-auth-codex"
      - "app-server"
      - "--listen"
      - "stdio://"
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

- `codex_executable` 用 `/usr/bin/env`，因为需要在 argv 里注入 `CODEX_MULTI_AUTH_*` 环境变量。
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1` 打开 runtime Responses proxy。
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN` 必须指向真实 official Codex CLI，不要指回 `codex-multi-auth-codex`。
- `codex_home` 指向服务端专用 Codex home。
- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0` 和 `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP=0` 用来避免启动时改写全局 Codex CLI 状态。
- `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0` 保持服务端统一账号池，不按项目拆账号池。
- `server.security.deployment_mode` 保持 `trusted-proxy`，由上游注入可信 `X-Ripple-User-Id`。
- `server.user_auth.enabled` 生产保持 `false`。轻量邀请码登录只用于开发/内测。
- `server.cors.allowed_origins` 生产只填明确 origin，不使用 `allow_any_origin`。

如果想使用耗尽一个账号再切下一个的策略，可以在 `app_server_args` 里增加：

```yaml
      - "CODEX_AUTH_SCHEDULING_STRATEGY=sequential"
```

默认不加时使用 `codex-multi-auth` 的 `hybrid` 策略：综合账号健康、quota、session affinity、冷却时间和最近切换情况自动选择。

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
command -v codex-multi-auth
command -v codex-multi-auth-codex
```

版本和 sandbox probe：

```bash
node --version
npm --version
uv --version
codex --version
codex-multi-auth --version
codex-multi-auth-codex --version
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

触发一次 Codex 请求后，验证 multi-auth 进程链：

```bash
ps -eo pid,ppid,cmd \
  | grep -E 'ripple-server|codex-multi-auth-codex|codex-real|app-server' \
  | grep -v grep
```

期望看到类似：

```text
ripple-server
node /usr/bin/codex-multi-auth-codex app-server --listen stdio:// ...
/usr/bin/codex-real-0.142.5 app-server --listen stdio:// ... -c model_provider="codex-multi-auth-runtime-proxy"
```

检查 runtime 文件：

```bash
find /nas/ripple-data/codex-multi-auth -maxdepth 2 -type f | sort
find /nas/ripple-data/codex-runtime/users -maxdepth 4 -name auth.json -printf '%p -> %l\n'
```

期望：

- `/nas/ripple-data/codex-multi-auth/openai-codex-accounts.json` 存在。
- `/nas/ripple-data/codex-multi-auth/quota-cache.json`、`runtime-observability.json` 或 `usage/usage-ledger.jsonl` 在请求后有更新。
- user runtime 下的 `codex-home/auth.json` 指向 `/nas/ripple-data/codex-service-home/auth.json`。

账号池状态：

```bash
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth status
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth rotation status
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth why-selected --json
```

如果前端从公网访问后端，需要确认：

- 云安全组和防火墙放通 `8810` 或反向代理端口。
- `server.public_base_url` 配成浏览器可访问的公网地址。
- OAuth provider 的 callback URL 与 `server.public_base_url` 匹配。
- 当前 HTTP IP 过渡期客户端允许明文 HTTP；恢复 HTTPS 后移除明文例外。

### 运行时日志清理

Codex 自身会写入 `logs_2.sqlite`，主要是 trace/debug 级运行时日志。它不参与 Ripple 会话列表、消息恢复或 Codex thread 续聊；这些依赖的是 `/nas/ripple-data/ripple-runtime/ripple.sqlite`、Codex runtime `state_5.sqlite` 和 thread rollout 文件。

Ripple Server 启动后会按配置自动清理这些日志库：

- `/nas/ripple-data/codex-runtime/users/<user_id>/sqlite/logs_2.sqlite`
- `/nas/ripple-data/sandboxes/<user_id>/codex-home/logs_2.sqlite`，仅兼容旧布局
- `/nas/ripple-data/codex-service-home/logs_2.sqlite`

默认策略：

- 删除超过 `runtime_log_retention_seconds` 的旧日志。
- 执行 SQLite checkpoint 和 `VACUUM` 缩小文件。
- 如果单个日志库仍超过 `runtime_log_max_mb`，清空 `logs` 表并再次 `VACUUM`。
- 如果日志库正被 Codex 写入导致短暂锁冲突，本轮跳过，下个周期重试。

不要把下面这些路径当成普通日志清理：

- `/nas/ripple-data/ripple-runtime/ripple.sqlite*`
- `/nas/ripple-data/codex-runtime/users/<user_id>/sqlite/state_5.sqlite`
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

建议停服务或冻结写入后备份。生产多账号部署必须备份：

- `/nas/ripple-data/ripple-runtime/ripple.sqlite`
- `/nas/ripple-data/ripple-runtime/ripple.sqlite-wal`
- `/nas/ripple-data/ripple-runtime/ripple.sqlite-shm`
- `/nas/ripple-data/sandboxes/<user_id>/workspace`
- `/nas/ripple-data/sandboxes/<user_id>/credentials`
- `/nas/ripple-data/sandboxes/<user_id>/agent-runs`
- `/nas/ripple-data/sandboxes/<user_id>/sessions`
- `/nas/ripple-data/codex-service-home/auth.json`
- `/nas/ripple-data/codex-multi-auth/openai-codex-accounts.json`

可以排除：

- `/nas/ripple-data/sandboxes-cache`

升级前先备份，再替换 `/opt/ripple/ripple-server` 和配置。服务启动时，旧的 `queued/running` jobs 会标记为 `interrupted_by_restart`，客户端可重试。Run output 下载使用 `/v1/runs/:job_id/output`，不要依赖 host path。

如果使用仓库内的每日 NAS 镜像脚本，先确认 `ops/systemd/ripple-runtime-backup.service` 和 `scripts/backup-ripple-runtime-to-nas.sh` 中的源路径已经改成当前部署路径；旧开发机路径不能直接用于生产。

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
ps -eo pid,ppid,cmd | grep -E 'codex-multi-auth-codex|codex-real|app-server' | grep -v grep
journalctl -u ripple-server -n 200 --no-pager
```

常见原因：

- `CODEX_MULTI_AUTH_REAL_CODEX_BIN` 指向不存在的路径。
- `codex-multi-auth-codex` 不在服务进程 `PATH` 里。
- `app_server_args` 里出现空字符串或顺序错误。
- 服务端 `codex_home/auth.json` 不存在。
- `bwrap` 或 user namespace probe 失败。

账号池为空时，确认所有命令都带同一个 `CODEX_MULTI_AUTH_DIR`：

```bash
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth list
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth login --device-auth
```

账号被 pin 住、不自动切换时：

```bash
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth status
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth unpin
```

所有账号都不可用时：

```bash
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth report --live
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth check
CODEX_MULTI_AUTH_DIR=/nas/ripple-data/codex-multi-auth codex-multi-auth verify-flagged
```

修改配置后没有生效时，重启 Ripple Server。必要时在维护窗口确认旧 worker 已退出：

```bash
pkill -f 'codex-multi-auth-codex app-server' || true
pkill -f 'codex-real-.* app-server' || true
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
npm install -g codex-multi-auth@2.3.3
ln -sf "$(readlink -f "$(which codex)")" /usr/bin/codex-real-0.142.5

cd /opt/ripple
ln -sfn /nas/ripple-data/ripple-runtime .ripple
RIPPLE_CONFIG=/opt/ripple/config/settings.yaml ./ripple-server
```

如果没有迁移 `/nas/ripple-data/codex-service-home/auth.json` 或 `/nas/ripple-data/codex-multi-auth/openai-codex-accounts.json`，需要重新执行上面的服务端 Codex 登录和 `codex-multi-auth login --device-auth`。

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
