# 会话管理二级菜单设计方案 (Workspace Session Context Menu Design)

## 1. 目标 (Goal)
在 `WorkspaceNav` 侧边栏的会话列表项中，实现一个更专业的会话管理菜单。当鼠标悬停在特定会话项上时，显示一个“三点”按钮 (More Actions)，点击该按钮弹出二级上下文菜单。
菜单包含以下操作：
1. **置顶 / 取消置顶 (Pin / Unpin)**：切换会话的置顶状态，置顶的会话在列表中前面会有一个钉子 (Pin) 标记。
2. **重命名 (Rename)**：点击后触发该会话标题直接进入行内编辑状态 (Inline Input)，支持按回车键或失去焦点保存，Esc 键取消。
3. **删除 (Delete)**：点击后直接删除该会话（调用 `onDeleteSession`，保持原有删除流）。

---

## 2. 交互细节与状态设计 (Interactive States)

每个会话项的数据模型由 `WorkbenchSessionSummary` 表示。为了支持这些交互，我们将在 `WorkspaceNav` 中维护以下状态：

1. **`activeMenuSessionId: string | null`**
   - 当前打开了二级下拉菜单的 `sessionId`。
   - 当点击某个会话的 `...` 按钮时，设置该值以显示对应的下拉菜单。
   
2. **`editingSessionId: string | null`**
   - 当前正在进行行内重命名编辑的 `sessionId`。
   - 同一时刻只允许编辑一个会话名称。

3. **`editingTitle: string`**
   - 正在编辑的会话名称暂存文本。

### 交互触发点：
- **悬停状态 (Hover)**：当鼠标悬停在会话项上时，显示三点按钮（替代原本直接显示的垃圾桶按钮）。
- **二级菜单打开 (Dropdown Open)**：
  - 点击三点按钮，阻止事件冒泡 (`e.stopPropagation()`)，弹出菜单。
  - 页面渲染一个全屏透明背景层 (`fixed inset-0 z-40`)。点击该层会清空 `activeMenuSessionId`，实现“点击外部自动关闭 (Click-outside)”。
- **重命名行内编辑 (Inline Rename)**：
  - 点击“重命名”菜单项，关闭下拉菜单，并将 `editingSessionId` 设为当前 ID，`editingTitle` 初始化为 `session.title`。
  - 原本展示标题的 `button` 区域变成一个文本 `input` 框。
  - 编辑状态下，对 `input` 注册：
    - `onChange`：更新 `editingTitle`。
    - `onKeyDown` (Enter)：调用 `onUpdateSession` 保存，退出编辑。
    - `onKeyDown` (Escape)：退出编辑，放弃修改。
    - `onBlur`：调用 `onUpdateSession` 保存，退出编辑。
    - 自动聚焦 (`autoFocus`)，并可以使用 `useRef` 或直接 DOM 在挂载时全选文本以优化体验。
- **置顶 (Pin / Unpin)**：
  - 点击菜单中的“置顶 / 取消置顶”，调用 `onUpdateSession(session.sessionId, { pinned: !session.pinned })`，并关闭二级菜单。
  - 列表中已置顶的会话项标题前显示钉子 (Pin) 标记。

---

## 3. 代码变动与 API 变更 (Code Changes)

### 3.1 `WorkspaceNav` 属性新增
在 `WorkspaceNavProps` 中添加 `onUpdateSession` 属性：

```typescript
interface WorkspaceNavProps {
  // ... 原有属性 ...
  onUpdateSession: (sessionId: string, updates: { title?: string; pinned?: boolean }) => Promise<any>;
}
```

### 3.2 `App.tsx` 挂载传递
在 `App.tsx` 中，已有 `updateSessionById`（通过 `useSessionLifecycle` 返回）。我们将此函数直接传给 `WorkspaceNav`：

```typescript
<WorkspaceNav
  // ... 其他属性 ...
  onUpdateSession={updateSessionById}
/>
```

---

## 4. 安全与边界情况 (Edge Cases & Safety)

1. **会话切换冲突**：
   - 处于行内编辑状态时，点击输入框本身不应该触发会话切换；应调用 `e.stopPropagation()` 阻止事件冒泡。
2. **长标题适配**：
   - 输入框最大长度限制为 120 字符（对齐 `SessionPage.tsx` 中的重命名限制）。
   - 输入框继承 `truncate` 和 `w-full` 类，确保超长文字不会撑破侧边栏。
3. **空标题防御**：
   - 如果用户输入为空标题，重命名保存时应自动放弃或回滚为原标题，防止保存空白标题。

---

## 5. 测试计划 (Test Plan)
1. **渲染测试**：验证在提供 `pinned: true` 时，会话项前端正确显示 `Pin` 标志。
2. **交互测试**：
   - 验证三点按钮在悬停时出现。
   - 验证点击三点按钮能成功唤起 Dropdown。
   - 验证点击 Dropdown 外部能够成功关闭菜单。
   - 验证点击“重命名”菜单项能成功切换到行内 Input 状态。
   - 验证按回车或失去焦点能够触发 `onUpdateSession`。
