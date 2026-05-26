# Design Spec: Sandbox Status Dashboard on HomePage

本设计文档阐述如何将 `HomePage` 组件中不常用的 "Recent sessions" 区域替换为功能和信息更加丰富的 "Sandbox Status"（沙箱运行状态与配额）大控制面板，并允许直接在主页卡片内快速切换用户。

## 1. 目标 (Goals)

- 移除主页 (`HomePage`) 底部多余的 "Recent sessions" 卡片区域。
- 引入全面展示沙箱健康与用量的 "Sandbox Status" 仪表盘卡片：
  - 提供绿色状态呼吸灯，清晰地向用户展示沙箱处于活跃/正常（Active）运行中。
  - 展示 **Disk Usage** (磁盘文件用量占 2GB 限额的百分比、进度条、实际字节大小)。
  - 展示 **Active Sessions** (当前活跃会话数占 200 会话限额的百分比、进度条、实际数量)。
  - 展示 **Token Usage Stats** (每日、每周、历史总 Token 消耗)。
  - 提供 **Switch User** 的内联切换表单（带非法字符校验 `/^[a-zA-Z0-9_-]{1,64}$/`），允许在此一键切换当前用户沙箱。

## 2. 系统架构与组件数据流 (Data Flow)

### 2.1 涉及组件
- `app/src/components/workbench/HomePage.tsx` (主要修改)
- `app/src/App.tsx` (传递 `onUserIdChange` 句柄)

### 2.2 数据源 (Data Source)
在主页数据加载 `loadSummary` 回调中，除并行加载 `fetchCurrentSandbox`、`fetchConnectors` 之外，并行请求 `fetchUserProfile` 来获取最新配额和 Token 信息：
```typescript
const [sandboxData, connectorList, profileData] = await Promise.all([
  fetchCurrentSandbox(),
  fetchConnectors(),
  fetchUserProfile(),
]);
```
加载完成后的状态将被存储在 `userUsageData` 中：
```typescript
interface UsageData {
  user_id: string;
  usage?: {
    workspace_size_bytes: number;
    session_count: number;
    runs_today: number;
    active_runs: number;
    total_tokens?: number;
    daily_tokens?: number;
    weekly_tokens?: number;
  };
}
```

## 3. UI/UX 设计与布局说明

新卡片整体保留 `HomePage` 现有的圆角、浅色玻璃态（`bg-white/74 backdrop-blur-xl border-[#dfe6f4]`）的设计风格：

1. **第一栏：沙箱状态标题 (Header Row)**
   - 包含带微弱闪烁动画的绿色小呼吸灯（使用 Tailwind 的 `relative flex h-1.5 w-1.5` 与 `animate-ping`）。
   - 标题文字为 “Sandbox Status”。
   - 当正在加载用量数据或执行其他重置时，右侧展示 `Loader2` 旋转动画。

2. **第二栏：存储和会话百分比 (Metrics & Progress Bars)**
   - 使用两列（`grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-3`）排版。
   - **Disk Usage**：
     - 图标：`HardDrive` (灰蓝色 `#6b7280`)。
     - 百分比：`(bytes / (1024 * 1024) / 2048) * 100`，格式化保留一位小数。
     - 进度条：使用 Tailwind 实现高精度圆角圆滑过渡。
     - 限额说明：“1.2 MB of 2 GB”。
   - **Active Sessions**：
     - 图标：`Layers` (灰蓝色 `#6b7280`)。
     - 百分比：`(session_count / 200) * 100`。
     - 进度条：同上，蓝色亮丽进度。
     - 限额说明：“7 of 200 sessions”。

3. **第三栏：Token 统计报表 (Token Usage Panel)**
   - 在卡片内嵌套一层精细的灰色小底盒（圆角 `rounded-xl`，背景 `#f8fafc`）。
   - 顶部提供 Lucide 的 `Cpu` 图标及标签文字 “Token Usage Stats”。
   - 下方采用三列均分的精简网格布局，分别显示 **Daily**、**Weekly**、**All-time** 三种粒度的已消耗 Token，并且使用 `formatTokens` 函数将其美化。

4. **第四栏：当前活跃沙箱及快速切换 (Footer & Switch Form)**
   - 采用细线与上方内容分割，背景微微淡化。
   - 左侧：`Active Sandbox: <userId>` 徽章。
   - 右侧：
     - 在非编辑态下显示 **"Switch User"** 轻量级按钮。
     - 在编辑态下变成极简内联 input 框，自带一键确认（Check 图标）和取消（X 图标），支持热键（Enter 保存，Escape 取消）。

## 4. 边界处理与可靠性
- 字符校验：User ID 只能包含字母、数字、短横线和下划线，1~64 字符。不合法时弹出清晰提示，不允许保存。
- 异常保护：当 `fetchUserProfile` 请求失败时，优雅地将状态回退到空值（不导致页面崩溃）。
- 加载状态：拉取数据期间，相关数字区域显示骨架屏或 Loading 微调，避免由于瞬间的数据不一致产生跳变。
