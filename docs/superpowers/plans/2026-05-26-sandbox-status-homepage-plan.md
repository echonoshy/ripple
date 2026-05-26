# Implementation Plan: Sandbox Status Dashboard on HomePage

本计划描述了如何将 `HomePage` 组件中不常用的 "Recent sessions" 区域替换为功能和信息更加丰富的 "Sandbox Status" 卡片，并支持在该卡片中一键切换用户。

## 1. 实施步骤概要 (Summary of Steps)

### Step 1: 修改 `HomePage.tsx` 的 Props 与依赖导入
- 允许向 `HomePage` 传递 `onUserIdChange: (newUserId: string) => void` 句柄，从而在主页内部直接触发切换用户操作。
- 引入 `fetchUserProfile` API 请求函数。
- 导入相关的 Lucide 图标（`HardDrive`, `Layers`, `Cpu`, `Check`, `X`, `Settings` 等）。
- 声明格式化工具函数 `formatTokens`。

### Step 2: 实现状态和数据加载 (State & API Fetching)
- 在 `HomePage.tsx` 内部定义：
  - `userUsageData` (存储 `fetchUserProfile` 的返回值类型或 null)
  - `isLoadingUsage` (布尔值)
  - `isSwitchingUser` (布尔值)
  - `newUserDraft` (字符串)
- 在 `loadSummary` 回调函数中，并行加载 `fetchCurrentSandbox()`, `fetchConnectors()` 以及 `fetchUserProfile()`。如果 `fetchUserProfile()` 抛出错误，则静默捕获并设为 `null`，确保应用稳定性。
- 为 `isSwitchCancelRef` 等切换逻辑定义 Ref 防抖/状态取消拦截，防止失焦冲突。

### Step 3: 重构页面组件渲染 (UI Implementation)
- 移除 `HomePage.tsx` 中原有的 “Recent sessions” 的整个 `<section>` 卡片。
- 在原位置重新编写一个带有毛玻璃质感的全新沙箱状态控制卡片 `<section>`：
  - **Header 区域**：带闪烁动画的绿色状态呼吸灯，显示 "Sandbox Status"，并在数据加载时在右侧显示 `Loader2` 旋转。
  - **Metrics 进度条区域**：采用两列排版（`grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-3`），分别展示磁盘空间与活跃会话，包含用量占比的百分比、高精度进度条，以及当前数值对最大配额（2 GB / 200 会话）的详细对比描述。
  - **Token Usage 统计区域**：嵌套圆角卡片面板，使用 Lucide `Cpu` 图标。包含 3 列 Token 统计（Daily、Weekly、All-time），全部通过 `formatTokens` 格式化后高亮显示。
  - **页脚切换用户区域**：
    - 上部以淡雅分割线 `border-t` 分开。
    - **非编辑态**：左侧展示灰色圆角 Badge 包含 “Active Sandbox: {userId}”；右侧展示按钮 “Switch User”，点击可进入编辑。
    - **编辑态**：内联 Form，包含一个带有 Check (保存) 和 X (取消) 图标的精美输入框，提供输入焦点并对输入的 User ID 进行 `/^[a-zA-Z0-9_-]{1,64}$/` 规则强校验。如果检验通过，则调用 `onUserIdChange` 更新全局用户状态。

### Step 4: 修改全局 `App.tsx` 中的传递
- 找到 `App.tsx` 实例化 `<HomePage>` 的地方。
- 向其传递 `onUserIdChange={handleUserIdChange}` 句柄：
  ```typescript
  <HomePage
    userId={userId}
    sessions={displayWorkbenchSessions}
    isLoadingSessions={isLoadingSessions}
    onNewSession={handleNewSession}
    onSelectSession={(selectedSessionId) => void handleSwitchSession(selectedSessionId)}
    onSelectView={handleSelectView}
    onOpenSettings={() => setIsSettingsOpen(true)}
    onUserIdChange={handleUserIdChange} // 新增
  />
  ```

### Step 5: 验证编译、Lint 及运行时表现
- 运行 `bun run lint` 验证前端代码是否引入任何 Lint 错误或 TypeScript 编译类型不兼容。
- 确认样式及界面渲染。

---

## 2. 详细的 API 与逻辑细节

### 2.1 格式化函数
```typescript
function formatTokens(num: number): string {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(1) + "B";
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + "K";
  }
  return num.toString();
}
```

### 2.2 用户 ID 校验逻辑
```typescript
const handleSave = () => {
  if (!isSwitchingUser) return;
  if (isSwitchCancelRef.current) {
    isSwitchCancelRef.current = false;
    return;
  }
  const trimmed = newUserDraft.trim();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    onUserIdChange(trimmed);
    setIsSwitchingUser(false);
  } else {
    alert(
      "User ID can only contain alphanumeric characters, dashes, and underscores (1-64 characters)."
    );
  }
};
```
