# Ripple Mobile App Changes

这份文档记录近期移动端界面、对话渲染与平台打包相关改动，方便后续排查和回顾。

## iOS 弹窗圆角

Settings 和 Sessions 弹窗都改为 React Native `Modal` 的全屏展示：

```tsx
presentationStyle="fullScreen"
```

这样 iOS 不再使用 `pageSheet` 的系统卡片样式，顶部不会出现系统圆角。

涉及位置：

- `src/interfaces/mobile/App.tsx`：`SettingsModal`
- `src/interfaces/mobile/App.tsx`：`SessionsModal`

## 对话文本复制

对话中的主要可读文本增加了 `selectable`，支持在 iOS 上长按选中和复制。

覆盖范围：

- 用户消息正文。
- Assistant Markdown 正文。
- Markdown 标题、段落、引用、列表、表格、代码块。
- AskUser 问题文本。
- 工具调用名称、参数、结果。
- 权限请求中的工具名和参数。
- Settings 诊断输出。

按钮文案没有强制设为可选中，因为按钮主要负责点击操作，可选中文本容易影响按钮交互手感。

## Markdown URL 渲染与点击

移动端新增 Markdown 渲染路径，Assistant 回复不再只按普通纯文本展示。

当前支持：

- 标题、段落、引用、列表、任务列表。
- fenced code block。
- Markdown 表格。
- inline code、bold、italic。
- 标准 Markdown 链接：`[label](https://example.com)`。
- 裸 URL 自动识别：`https://example.com`、`http://example.com`、`www.example.com`。
- URL 末尾句号、逗号等标点不会被吞进链接。
- Markdown 链接 URL 中带平衡括号时可以正确解析。

点击链接时：

- 已带协议的 URL 直接打开。
- `www.example.com` 这类裸域名会自动补成 `https://www.example.com` 再打开。

涉及位置：

- `src/interfaces/mobile/src/components/MarkdownText.tsx`
- `src/interfaces/mobile/src/markdown/parseMarkdown.ts`
- `src/interfaces/mobile/src/markdown/parseMarkdown.test.ts`
- `src/interfaces/mobile/src/components/ChatMessage.tsx`

## iOS 启动与 Release 构建说明

iOS 模拟器启动、后端启动、`ios:codegen`、`pod install`、`ios:release` 的说明记录在：

- `docs/MOBILE_IOS.md`

## Android IP-only 与发布配置

Android 增加独立 package id，并通过 EAS profile 区分当前 IP-only 测试包和后续 HTTPS 正式包：

- `src/interfaces/mobile/app.json`：配置 `android.package`。
- `src/interfaces/mobile/app.config.js`：按 `RIPPLE_ANDROID_USES_CLEARTEXT` 注入 Android cleartext build property。
- `src/interfaces/mobile/eas.json`：新增 `preview` 和 `production` Android 构建策略。

Android 本地运行、预览 APK 和正式 AAB 的说明记录在：

- `docs/MOBILE_ANDROID.md`

移动端 README 也增加了该文档入口：

- `src/interfaces/mobile/README.md`

## 验证

移动端改动后执行：

```bash
cd /Users/lake/workspace/ripple/src/interfaces/mobile
npm test
npm run typecheck
```

最近一次验证结果：

- `npm test` 通过。
- `npm run typecheck` 通过。
