# Workspace Explorer 右键菜单与预览区域自适应优化设计方案

本方案旨在为 `WorkspaceExplorer` 增加精致的桌面级文件管理右键菜单功能（重命名、复制、移动/剪切、复制沙盒路径、下载、删除、新建文件/新建文件夹），并优化文件预览区域的默认展示逻辑，使其在未选中文件时完全自适应隐藏。

## 1. 业务目标

1. **更强的文件交互操作**：支持右键直接对沙盒内的文件/文件夹执行桌面式交互。
2. **类似剪贴板的文件移动 (选项 C)**：支持选中文件 -> 剪切/复制 -> 切换目录 -> 粘贴，实现跨文件夹的文件移动或复制。
3. **视觉布局优化**：预览区域默认关闭，只有选中文件后才平滑展开展开。

---

## 2. 系统架构与接口定义

由于沙盒运行于后端独立 Linux 环境，所有实际的文件操作必须透过 Ripple 后端控制面进行隔离和限额校验。因此我们需要补充相关的后端 API。

### 2.1 后端 API 变更 (`crates/ripple-server/`)

在 `crates/ripple-server/src/api/workspace.rs` 中实现三个原子服务接口，并在 `crates/ripple-server/src/api/mod.rs` 注册路由。

#### 1) 删除文件/目录接口
* **端点**: `POST /workspace/delete`
* **鉴权**: 支持 `X-Ripple-User-Id` 和 `Authorization: Bearer <key>`
* **请求体 (JSON)**:
  ```json
  {
    "path": "/workspace/docs/notes.txt"
  }
  ```
* **逻辑**: 校验用户沙箱权限，检查路径合法性。通过 `tokio::fs::remove_file` / `tokio::fs::remove_dir_all` 递归删除，并在存储数据库中清除对应的引用。

#### 2) 文件移动/复制 (粘贴) 接口
* **端点**: `POST /workspace/paste`
* **请求体 (JSON)**:
  ```json
  {
    "path": "/workspace/docs/notes.txt",
    "destination_dir": "/workspace/src",
    "action": "move"
  }
  ```
  *(其中 `action` 为 `"move"` 或 `"copy"`)*
* **逻辑**:
  * 如果是 `"move"`，通过 `std::fs::rename` 实现移动。
  * 如果是 `"copy"`，若为文件，则使用 `tokio::fs::copy`；若为目录，则使用递归复制方案。
  * 更新该用户在存储层（quota、file_ref）的文件空间引用大小。

#### 3) 新建文件/目录接口
* **端点**: `POST /workspace/create`
* **请求体 (JSON)**:
  ```json
  {
    "path": "/workspace/src/new_file.py",
    "kind": "file"
  }
  ```
  *(其中 `kind` 为 `"file"` 或 `"directory"`)*
* **逻辑**:
  * 如果是 `"file"`，在目标路径创建空文件，初始化大小为 0。
  * 如果是 `"directory"`，使用 `tokio::fs::create_dir_all` 创建空目录。

---

### 2.2 前端 API 适配 (`app/src/lib/api.ts`)

在前端 `api.ts` 中增加对应的 TypeScript RPC 客户端调用。

```typescript
export async function deleteWorkspaceEntry(path: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/workspace/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  return res.ok;
}

export async function pasteWorkspaceEntry(
  path: string,
  destinationDir: string,
  action: "copy" | "move"
): Promise<WorkspaceEntry> {
  const res = await fetch(`${API_URL}/workspace/paste`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, destination_dir: destinationDir, action }),
  });
  if (!res.ok) throw new Error(`Paste failed (${res.status})`);
  return (await res.json()) as WorkspaceEntry;
}

export async function createWorkspaceEntry(
  path: string,
  kind: "file" | "directory"
): Promise<WorkspaceEntry> {
  const res = await fetch(`${API_URL}/workspace/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, kind }),
  });
  if (!res.ok) throw new Error(`Create failed (${res.status})`);
  return (await res.json()) as WorkspaceEntry;
}
```

---

## 3. 前端 UI 与交互细化 (`app/src/components/WorkspaceExplorer.tsx`)

### 3.1 自定义右键菜单 (Context Menu) 组件
我们将在 `WorkspaceExplorer.tsx` 内部定义一个局部精美的 `ContextMenu` 浮动组件：
* 通过监听整个容器的 `onContextMenu` 以及文件列表项的 `onContextMenu`。
* 在事件触发时 `e.preventDefault()` 阻止浏览器默认右键，获取鼠标在可视区内的 `clientX` 和 `clientY`。
* 浮动菜单状态：
  ```typescript
  interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    entry: WorkspaceEntry | null; // null 表示在空白背景区点击右键
  }
  ```
* 剪贴板暂存状态：
  ```typescript
  interface ClipState {
    path: string;
    name: string;
    kind: "file" | "directory";
    action: "copy" | "cut";
  }
  const [clipboard, setClipboard] = useState<ClipState | null>(null);
  ```

### 3.2 列表项半透明 (Cut 视觉效果)
如果是执行了 **Cut (剪切)** 操作，当前被选中的 entry 项在列表中会呈现 **30% 的半透明不透明度**，代表它已被剪下。

### 3.3 预览区自适应隐藏优化
将原有的 `isPreviewPanelHidden` 更改为：
```typescript
const isPreviewPanelHidden = splitPercent >= MAX_SPLIT_PERCENT || !preview;
```
* **效果**：如果没有选中的文本文件时（`preview` 为 `null`），预览面板在底部的 Grid 布局中完全不渲染任何 DOM，高度收缩为 `0px`，列表全高。
* 只有当双击/单击文件将其加载进 `preview` 之后，预览区才会在分栏下方出现。

---

## 4. 任务检查与测试计划

1. **自研测试用例**：
   * 运行前端 lint 和构建，确保无 TS 类型报错。
   * 确保移动端/小屏幕下隐藏或保留点击菜单的适应性。
2. **测试场景**：
   * 场景一：右键点击文件，重命名是否正常、复制路径是否复制到真实 `/workspace/` 开头路径。
   * 场景二：右键文件选择“剪切”，页面该行变半透明；在空白区右键“粘贴”，文件成功被移动过去。
   * 场景三：在目录项上右键“粘贴”，把该文件移入该目录中（或者简单地将文件粘贴到当前所在的 `currentPath` 下）。
   * 场景四：初始化进去，预览面板完全隐藏，列表自适应填满。
