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

Web dev server 默认监听 `http://localhost:8820`。本地开发时，Vite 会把 `/v1` 代理到 `http://127.0.0.1:8810`，所以通常需要同时启动后端：

```bash
cargo run -p ripple-server
```

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
- Bundle ID 与 Tauri identifier 保持一致：`ai.viaim.ripple`。

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

TestFlight / release-testing 构建：

```bash
cd app
bun run tauri ios build --export-method release-testing --build-number 1
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
- `server.host` / `server.port`：监听地址和端口，默认 `0.0.0.0:8810`。
- `external_agents.codex.codex_home`：服务端 Codex 登录态目录。
- connector OAuth 配置，例如 Google Workspace / Feishu。

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
cp scripts/install-feishu-cli.sh scripts/install-notion-cli.sh scripts/install-gogcli-cli.sh dist/ripple-server/scripts/
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

推荐目录示例：

```text
/opt/ripple/
  ripple-server
  config/settings.yaml
  .ripple/
```

在服务器上准备 runtime：

```bash
cd /opt/ripple
chmod +x ./ripple-server
CODEX_HOME=/opt/ripple/.ripple/codex-service-home codex login
```

服务器上还需要能找到 `codex`、`nsjail`、Node/Bun 运行时和 Python helper 需要的基础工具；如路径不在默认 `PATH`，在 `config/settings.yaml` 中配置对应路径或通过 systemd `Environment=PATH=...` 注入。

如需 connectors，安装对应 CLI：

```bash
bash scripts/install-feishu-cli.sh
bash scripts/install-notion-cli.sh
bash scripts/install-gogcli-cli.sh
```

直接启动：

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
ExecStart=/opt/ripple/ripple-server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

部署后检查：

```bash
curl -fsS http://127.0.0.1:8810/health
curl -fsS \
  -H "Authorization: Bearer <RIPPLE_SERVER_API_KEY>" \
  -H "X-Ripple-User-Id: default" \
  http://127.0.0.1:8810/v1/models
```

如果前端从公网访问后端，需要确认：

- 云安全组和防火墙放通 `8810` 或反向代理端口。
- `server.public_base_url` 配成浏览器可访问的公网地址。
- OAuth provider 的 callback URL 与 `server.public_base_url` 匹配。
- 当前 HTTP IP 过渡期客户端允许明文 HTTP；恢复 HTTPS 后移除明文例外。

## 后端验证命令

常规验证：

```bash
cargo fmt -p ripple-server
cargo check -p ripple-server
cargo test -p ripple-server
bash scripts/smoke-rust-server.sh
```

文件存储迁移到 SQLite：

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
