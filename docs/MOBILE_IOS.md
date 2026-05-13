# Ripple Mobile iOS

这份文档记录 `src/interfaces/mobile` 的 iOS 常用启动和 Release 构建命令，方便后续查找。

## 日常启动 iOS 模拟器

从仓库根目录执行：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
proxy_on
npm run ios
```

含义：

- `cd .../src/interfaces/mobile`：进入 Expo / React Native 移动端项目目录。
- `proxy_on`：按本项目约定打开代理，避免安装依赖、调试网络请求或启动项目时遇到网络问题。
- `npm run ios`：运行 `package.json` 中的 `ios` 脚本，即 `expo run:ios`，用于日常 Debug 开发，会启动或连接 iOS Simulator。

如果只想启动 Expo Dev Server，然后手动选择模拟器：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
proxy_on
npm start
```

启动后在 Expo 终端中按 `i` 打开 iOS Simulator。

## 启动本地 Ripple 后端

移动端只是前端调用方，本地调试时通常需要另开一个终端启动后端：

```bash
cd /Users/lake/workspace/ripple
proxy_on
uv run ripple --reload
```

iOS Simulator 中 Settings 的 Server URL 通常填写：

```text
http://127.0.0.1:8810
```

如果是真机，不能使用 `localhost` 或 `127.0.0.1` 指向电脑。需要使用手机可访问的地址，例如：

```text
http://192.168.1.8:8810
https://ripple.example.com
```

## Release 构建命令

常见完整命令：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
npm run ios:codegen
cd ios
pod install
cd ..
npm run ios:release
```

这串命令是在重新生成 iOS 原生工程依赖，然后用 Release 配置构建并安装到 iPhone 或模拟器。

逐行含义：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
```

进入移动端 Expo / React Native 项目目录。

```bash
npm run ios:codegen
```

运行 `package.json` 中的 `ios:codegen` 脚本：

```bash
node node_modules/react-native/scripts/generate-codegen-artifacts.js -p . -t ios -o ios
```

含义是为 React Native iOS 生成原生 codegen 产物。通常在依赖、Native Module、React Native 版本变化后需要执行。

```bash
cd ios
pod install
```

进入 iOS 原生目录，安装 CocoaPods 依赖。它会根据 `Podfile` 和 React Native 原生依赖生成或更新 Xcode 需要的 Pods。

```bash
cd ..
npm run ios:release
```

运行 `package.json` 中的 `ios:release` 脚本：

```bash
npm run ios:codegen && expo run:ios --configuration Release --device
```

含义是先再次执行 codegen，然后使用 Expo / React Native 以 `Release` 配置构建 iOS App，并安装到连接的设备或可用目标上。

## 什么时候用哪个命令

- 日常修改 UI、看效果：使用 `npm run ios`。
- 只启动 Expo Dev Server：使用 `npm start`，再按 `i` 打开模拟器。
- 改了 iOS 原生依赖、Native Module、React Native 版本：执行 `npm run ios:codegen` 和 `pod install`。
- 真机测试性能、发布前检查、验证正式构建行为：使用 `npm run ios:release`。

## 常用验证

移动端代码改动后可运行：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
npm test
npm run typecheck
```
