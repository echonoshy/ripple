# Ripple iOS Tauri App

本文记录 Ripple iOS app 的当前推荐路线、实施步骤、验证清单和 TestFlight 发布路径。

## 结论

Ripple iOS 主线采用 **Tauri iOS 复用 Web 工作台**。

- `src/interfaces/web` 已经包含完整 Web 工作台和 Tauri v2 shell，覆盖 Sessions/Chat、Files、Connectors、Automations、Settings 等核心能力。
- `src/interfaces/mobile` 是 Expo/React Native 实验客户端，适合聊天 MVP，但目前不覆盖完整工作台。
- iOS app 仍然只是 Ripple Server 客户端，不嵌入后端控制面，也不运行 agent loop、sandbox、connector CLI 或 Codex app-server。
- 首阶段分发目标是真机和 TestFlight。
- 登录方式保留设置页手填 API key 和 `X-Ripple-User-Id`。
- 默认服务端使用现有 HTTPS `/v1` API：`https://test-oauth.weilai.ai/v1`。

参考：

- [Tauri CLI iOS commands](https://v2.tauri.app/reference/cli/)
- [Tauri App Store distribution](https://v2.tauri.app/zh-cn/distribute/app-store/)

## 项目依据

现有 Tauri shell 位于 `src/interfaces/web/src-tauri`：

- `tauri.conf.json` 已是 Tauri v2 配置。
- `src/lib.rs` 已带 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`。
- `vite.config.ts` 已根据 `TAURI_DEV_HOST` 调整 dev server host/HMR，这对 iPhone 真机调试很关键。

现有 Expo mobile 位于 `src/interfaces/mobile`：

- 已有 server URL、API key、user id、model、thinking 配置。
- 已有 session、流式 chat、tool call summary、AskUser、permission request、stop generation。
- 不作为完整 iOS 工作台主线，保留为聊天 MVP/实验客户端。

## 实施步骤

1. 恢复 Web/Tauri 工具链。

   ```bash
   cd src/interfaces/web
   bun install
   bun run tauri --version
   ```

   如果当前 shell 没有 `bun`，先恢复本机 Bun 安装或 PATH。项目声明的包管理器是 `bun@1.3.11`。

2. 初始化 iOS target。

   ```bash
   cd src/interfaces/web
   bun run tauri ios init
   ```

   该步骤会在 Tauri 工程下生成 iOS/Xcode 相关文件。生成后检查哪些文件需要纳入版本控制，避免提交临时 build 产物。

3. 补充 iOS/Tauri 配置。

   - 保持 bundle identifier 与 App Store Connect 中注册的 Bundle ID 一致；当前 Tauri identifier 是 `ai.weilai.ripple`。
   - 保持 production API 指向 `https://test-oauth.weilai.ai/v1`。
   - CSP 需要允许 production API、后端返回的图片/asset URL、`blob:` 和 Tauri asset 源。
   - 新增或检查 `Info.ios.plist`，包含 App Store/TestFlight 所需的 encryption export compliance 字段。
   - 不为 production iOS 开启任意 HTTP 加载；本地真机调试走 `tauri ios dev --host <LAN_IP>`。
   - 如新增 Tauri 插件，必须同步更新 Rust 初始化、JS 依赖和 capabilities 权限。

4. 增加 package scripts。

   建议在 `src/interfaces/web/package.json` 中补充：

   ```json
   {
     "scripts": {
       "tauri:ios:init": "tauri ios init",
       "tauri:ios:dev": "tauri ios dev",
       "tauri:ios:build:testflight": "tauri ios build --export-method release-testing"
     }
   }
   ```

5. 适配 iPhone 小屏体验。

   重点检查：

   - `WorkbenchShell` 的安全区、底部导航和 overlay nav。
   - `SessionPage` 和 `SessionComposer` 的键盘避让、输入框高度、发送/停止按钮触控区域。
   - Settings modal 在小屏上的高度、滚动、保存按钮位置。
   - Files、Connectors、Automations 的列表密度、横向溢出、长文本换行。
   - tool call、permission request、AskUser、connector auth 卡片在 375px 宽度下不遮挡内容。

## 验证清单

静态验证：

```bash
cd src/interfaces/web
bun run lint
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
```

真机开发验证：

```bash
cd src/interfaces/web
bun run tauri ios dev --host <LAN_IP>
```

TestFlight 构建验证：

```bash
cd src/interfaces/web
bun run tauri ios build --export-method release-testing --build-number 1
```

功能验收：

- Settings 中 API key、user id、server URL 保存后重启仍可用。
- 能拉取 models 和 sessions。
- 能创建/切换 session。
- `/v1/chat/completions` 流式输出正常。
- tool call、tool result、permission request、AskUser、stop generation 正常。
- Files 可浏览、预览、上传、下载。
- Connectors 状态、账号列表和授权入口可用。
- Automations 可创建、更新、删除和 run-now。
- iPhone 小屏没有横向滚动，底部输入框不被键盘或 safe area 遮挡。

## TestFlight 发布

1. 在 Apple Developer/App Store Connect 中注册 app。
2. Bundle ID 必须匹配 `tauri.conf.json` 的 `identifier`。
3. 配置 signing certificate 和 provisioning profile。
4. 使用 Tauri CLI 或 Xcode 归档构建 IPA。
5. 上传到 App Store Connect。

   ```bash
   xcrun altool --upload-app \
     --type ios \
     --file "src-tauri/gen/apple/build/arm64/Ripple.ipa" \
     --apiKey "$APPLE_API_KEY_ID" \
     --apiIssuer "$APPLE_API_ISSUER"
   ```

6. 在 TestFlight 中完成处理、合规信息和测试员分发。

## 注意事项

- Ripple Server 仍是独立后端，不能把服务端业务逻辑放进 iOS/Tauri 前端。
- iOS app 不能依赖 `localhost` 访问生产服务；真机调试必须使用可被手机访问的 LAN IP、Tailscale、tunnel 或 HTTPS 域名。
- API key、OAuth credential、connector token、Codex auth 不得提交到仓库。
- Tauri iOS 是 WebView 型移动 app，优点是复用完整工作台；风险是需要认真打磨触控、键盘、安全区和小屏布局。
- Expo mobile 继续保留，但除非重新定义范围，不承担完整工作台和 TestFlight 主线。
