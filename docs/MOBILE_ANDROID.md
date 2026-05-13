# Ripple Mobile Android

这份文档记录 `src/interfaces/mobile` 的 Android 本地运行、IP-only 测试包和后续商店发布路径。

## 当前发布策略

- iOS 和 Android 共用同一套 React Native / Expo 业务代码。
- iOS 平台身份继续使用 `ios.bundleIdentifier`。
- Android 平台身份使用 `android.package`：`com.lake.ripple.mobile`。
- 平台差异放在 Expo/EAS 配置里，不拆两套 app。
- 当前只有 IP 地址时，使用 Android cleartext profile 跑本地或预览包。
- 后续补上 HTTPS 域名后，使用 production profile 构建正式 AAB。

## 本地运行

从仓库根目录进入移动端项目：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
npm install
```

如果后端地址是 HTTPS：

```bash
npm run android
```

如果后端地址还是 `http://<ip>:<port>`：

```bash
RIPPLE_ANDROID_USES_CLEARTEXT=true npm run android
```

手机或模拟器里填写可访问的 Ripple Server 地址，例如：

```text
http://140.143.229.103:8810
http://192.168.1.8:8810
```

不要填写 `localhost`，因为手机上的 `localhost` 指的是手机自身，不是运行 Ripple Server 的机器。

## IP-only 测试 APK

当前没有 HTTPS 域名时，先使用 `preview` profile 构建内部测试 APK：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
eas build --platform android --profile preview
```

`preview` profile 会设置：

```text
RIPPLE_ANDROID_USES_CLEARTEXT=true
```

这会通过 `expo-build-properties` 只给 Android 写入 `usesCleartextTraffic=true`，方便 release-like APK 访问 `http://IP:PORT` 后端。

## 正式发布 AAB

HTTPS 域名准备好之后，使用 production profile：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
eas build --platform android --profile production
```

`production` profile 会设置：

```text
RIPPLE_ANDROID_USES_CLEARTEXT=false
```

也就是正式包默认不允许明文 HTTP。用户在 App 设置里填写 HTTPS 后端地址，例如：

```text
https://ripple.example.com
```

提交到 Google Play：

```bash
eas submit --platform android --profile production
```

第一次提交前还需要在 Google Play Console 创建应用，并按 EAS 指引配置 service account / 上传权限。

## 配置文件

- `app.json`：放跨平台基础配置，以及 `ios.bundleIdentifier` / `android.package`。
- `app.config.js`：根据 `RIPPLE_ANDROID_USES_CLEARTEXT` 动态注入 Android build properties。
- `eas.json`：区分 `preview` 和 `production` 构建/提交 profile。

## 验证

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
npm test
npm run typecheck
```
