# Spec: 统一二级菜单及多端/Tab页面设计风格

本设计规格文档旨在将 Ripple App 的各个主要 Tab 界面、多端布局中的二级弹出菜单及基础版式风格进行高度统一，采用现代、灵动且精致的卡片化设计语言。

## 1. 统一设计规范 (Design System Tokens)

### 1.1 弹出二级菜单规范 (Dropdown Menu)
所有 Tab 页面、侧边栏及右键/操作触发菜单，均对齐以下卡片风格：
* **容器圆角**: `rounded-2xl`
* **容器描边**: `border border-[#dfe6f4]`（浅亮色边框）
* **容器背景**: `bg-white` (或 `bg-white/95 backdrop-blur-md` 增加质感)
* **容器内边距**: `p-1.5`
* **容器阴影**: 大卡片阴影 `shadow-[0_12px_36px_-4px_rgba(0,0,0,0.12),0_4px_16px_-2px_rgba(0,0,0,0.06)]`
* **进入过渡动画**: `animate-in fade-in-50 zoom-in-95 duration-100`
* **菜单项 (Menu Items)**: 
  * **普通操作项**: `flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]`
  * **危险操作项 (如 Delete/Remove)**: `flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#cf222e] transition-colors hover:bg-[#ffebe9] active:bg-[#ffd5d6]`
  * **项内图标**: 尺寸 `size={13}` 或 `size={14}`，普通操作项图标设为 `text-[#6b7280]`，危险操作项设为 `text-[#cf222e]`

### 1.2 触发图标统一
* 操作触发器一律使用横三点 **`MoreHorizontal`** (以前有横有竖)。
* 桌面端图标尺寸 `size={14}` 或 `size={15}`，移动端为 `size={18}`（配以大尺寸触控包围区）。

### 1.3 统一页面背景与排版
所有 5 个主要 Tab 视图 (`sessions`, `files`, `connectors`, `automations`, `home`) 的页面容器和间距规则对齐：
* **背景渐变**: 采用统一高透光、多色彩的高级渐变。
  `bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.12),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.11),transparent_32%),#fbfdff]`
* **移动端底部安全 Padding**: 统一增加 `pb-[calc(88px+env(safe-area-inset-bottom))]`，确保内容滑动到底部时不会被 `MobileTabBar` 遮挡。

---

## 2. 改造文件与修改明细

### 2.1 `MobileSessionsPage.tsx` (移动端会话列表)
* 二级菜单已具备 `rounded-2xl`，需统一菜单项样式，对齐 `transition-all active:bg-[#eef3ff]` 和圆角 `rounded-xl`。
* 径向渐变背景对齐统一公式。

### 2.2 `WorkspaceNav.tsx` (侧边栏会话列表菜单)
* 将触发图标由 `MoreHorizontal`（旧的且隐藏效果不一）统一为具有 hover/active 微动效的按钮，且二级下拉框由 `rounded-lg` 改造为规范的 `rounded-2xl p-1.5`，项圆角 `rounded-xl`。
* 加载动画和进入过渡动画对齐。

### 2.3 `WorkspaceExplorer.tsx` (工作空间浏览器/文件树)
* 将单项操作触发图标由 `MoreVertical`（竖三点）改为 **`MoreHorizontal`（横三点）**。
* 优化右键 / 弹出操作菜单的外观：
  * 右键菜单容器由 `rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.08)]` 改为 `rounded-2xl shadow-[0_12px_36px_-4px_rgba(0,0,0,0.12),0_4px_16px_-2px_rgba(0,0,0,0.06)] border border-[#dfe6f4] p-1.5`
  * 菜单项由 `rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]` 改为 `rounded-xl px-3 py-2 font-semibold hover:bg-[#f3f4f6] active:bg-[#eef3ff] transition-all`

### 2.4 各 Tab 界面 (`FilesPage`, `ConnectorsPage`, `AutomationsPage`, `HomePage`)
* **`FilesPage.tsx`**: 将背景渐变对齐，确保在移动端时底部 padding 同样为 `pb-[calc(88px+env(safe-area-inset-bottom))]`。
* **`ConnectorsPage.tsx`**: 检查并对齐背景渐变、底部 Padding 到 `pb-[calc(88px+env(safe-area-inset-bottom))]`。
* **`AutomationsPage.tsx`**: 检查并对齐背景渐变、底部 Padding 到 `pb-[calc(88px+env(safe-area-inset-bottom))]`。
* **`HomePage.tsx`**: 检查并对齐背景渐变、底部 Padding 到 `pb-[calc(88px+env(safe-area-inset-bottom))]`。
