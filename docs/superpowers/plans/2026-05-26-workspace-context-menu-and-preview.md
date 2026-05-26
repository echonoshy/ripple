# Workspace Explorer Context Menu and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为沙箱文件管理器 WorkspaceExplorer 增加桌面级的右键菜单功能（重命名、剪切移动、复制、复制沙箱绝对路径、下载、删除、新建文件和文件夹）以及在未选中文件时自动隐藏底部预览区域。

**Architecture:**
- **后端 (Rust)**: 在 `crates/ripple-server/src/workspace.rs` 增加递归删除、剪切/复制粘贴、新建文件/文件夹的原生文件系统逻辑，并对粘贴新产生的文件记录存储层 file_ref 并在保存时校验用户配额限制。在 `api/workspace.rs` 增加对应的端点。
- **前端 (React/TS)**: 在 `app/src/lib/api.ts` 暴露对应的 API 调用。在 `app/src/components/WorkspaceExplorer.tsx` 整合右键位置计算、内存剪贴板（Copy/Cut 视觉效果）、新建文件/文件夹对话框、右键弹出菜单。通过 `preview` 状态是否为空来隐藏或显示预览面板 Grid Row。

**Tech Stack:** Rust (axum, tokio, walkdir), React (TypeScript, TailwindCSS, Lucide icons)

---

### Task 1: Rust 底层文件系统功能补全

**Files:**
- Modify: `crates/ripple-server/src/workspace.rs`

- [ ] **Step 1: 增加删除文件或目录底层逻辑**
  在 `crates/ripple-server/src/workspace.rs` 中增加 `delete_entry` 函数：
  ```rust
  pub fn delete_entry(workspace_root: &Path, path: &str) -> anyhow::Result<()> {
      let target = validate_existing_path(path, workspace_root)?;
      if target == workspace_root.canonicalize()? {
          anyhow::bail!("Cannot delete workspace root");
      }
      if target.is_dir() {
          std::fs::remove_dir_all(&target)?;
      } else {
          std::fs::remove_file(&target)?;
      }
      Ok(())
  }
  ```

- [ ] **Step 2: 增加新建文件或目录底层逻辑**
  在 `crates/ripple-server/src/workspace.rs` 中增加 `create_entry` 函数：
  ```rust
  pub fn create_entry(
      workspace_root: &Path,
      path: &str,
      kind: &str,
  ) -> anyhow::Result<WorkspaceEntry> {
      let target = validate_write_path(path, workspace_root)?;
      if target.exists() {
          anyhow::bail!("A file or folder with that name already exists");
      }
      if let Some(parent) = target.parent() {
          std::fs::create_dir_all(parent)?;
      }
      if kind == "directory" {
          std::fs::create_dir_all(&target)?;
      } else {
          std::fs::write(&target, "")?;
      }
      entry_for_path(workspace_root, &target, None)
  }
  ```

- [ ] **Step 3: 增加复制和移动(粘贴)底层逻辑**
  在 `crates/ripple-server/src/workspace.rs` 中增加 `paste_entry` 函数：
  ```rust
  pub fn paste_entry(
      workspace_root: &Path,
      src_path: &str,
      dest_dir: &str,
      action: &str,
  ) -> anyhow::Result<WorkspaceEntry> {
      let src = validate_existing_path(src_path, workspace_root)?;
      let dest_parent = validate_existing_path(dest_dir, workspace_root)?;
      if !dest_parent.is_dir() {
          anyhow::bail!("Destination path is not a directory");
      }
      let file_name = src.file_name().ok_or_else(|| anyhow::anyhow!("Invalid source file name"))?;
      let dest = dest_parent.join(file_name);
      let dest = validate_write_path(
          &workspace_path(workspace_root, &dest)?,
          workspace_root,
      )?;

      if dest.exists() {
          anyhow::bail!("A file or folder with that name already exists");
      }

      if action == "move" {
          std::fs::rename(&src, &dest)?;
      } else if action == "copy" {
          if src.is_dir() {
              copy_dir_recursive(&src, &dest)?;
          } else {
              std::fs::copy(&src, &dest)?;
          }
      } else {
          anyhow::bail!("Invalid paste action");
      }

      entry_for_path(workspace_root, &dest, None)
  }

  fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
      std::fs::create_dir_all(dst)?;
      for entry in std::fs::read_dir(src)? {
          let entry = entry?;
          let ty = entry.file_type()?;
          if ty.is_dir() {
              copy_dir_recursive(&entry.path(), &dst.join(entry.file_name()))?;
          } else {
              std::fs::copy(&entry.path(), &dst.join(entry.file_name()))?;
          }
      }
      Ok(())
  }
  ```

- [ ] **Step 4: 运行 `cargo check -p ripple-server` 验证编译**
  Run: `cargo check -p ripple-server`
  Expected: PASS

---

### Task 2: Rust Web 路由及控制器接入

**Files:**
- Modify: `crates/ripple-server/src/api/workspace.rs`
- Modify: `crates/ripple-server/src/api/mod.rs`

- [ ] **Step 1: 新增删除路由控制器**
  在 `crates/ripple-server/src/api/workspace.rs` 中新增：
  ```rust
  #[derive(Debug, Deserialize)]
  pub struct DeleteInput {
      path: String,
  }

  pub async fn delete_workspace(
      State(state): State<AppState>,
      headers: HeaderMap,
      Json(input): Json<DeleteInput>,
  ) -> Result<StatusCode, ApiError> {
      let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
      let workspace = state.sandboxes.workspace_dir(&user_id)?;
      if !workspace.exists() {
          return Err(ApiError::not_found(format!("Sandbox not found")));
      }
      ws::delete_entry(&workspace, &input.path).map_err(map_workspace_error)?;
      // 可以在此处从数据库删除该用户对应的该文件的 file_refs（可选，级联逻辑底层有自动或可在此补充）
      Ok(StatusCode::OK)
  }
  ```

- [ ] **Step 2: 新增新建路由控制器**
  在 `crates/ripple-server/src/api/workspace.rs` 中新增：
  ```rust
  #[derive(Debug, Deserialize)]
  pub struct CreateInput {
      path: String,
      kind: String, // "file" | "directory"
  }

  pub async fn create_workspace(
      State(state): State<AppState>,
      headers: HeaderMap,
      Json(input): Json<CreateInput>,
  ) -> Result<Json<Value>, ApiError> {
      let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
      let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
      let entry = ws::create_entry(&workspace, &input.path, &input.kind).map_err(map_workspace_error)?;
      
      // 级联记录文件数据库引用 (若为文件类型)
      if input.kind == "file" {
          let target_path = ws::validate_existing_path(&entry.path, &workspace).map_err(map_workspace_error)?;
          record_file_ref(
              &state,
              &user_id,
              &workspace,
              &target_path,
              &ws::mime_type_for_path(&target_path),
              b"",
              None,
          )
          .await?;
      }

      Ok(Json(serde_json::to_value(entry).unwrap_or_else(|_| json!({}))))
  }
  ```

- [ ] **Step 3: 新增粘贴（移动/复制）路由控制器**
  在 `crates/ripple-server/src/api/workspace.rs` 中新增：
  ```rust
  #[derive(Debug, Deserialize)]
  pub struct PasteInput {
      path: String,
      destination_dir: String,
      action: String, // "move" | "copy"
  }

  pub async fn paste_workspace(
      State(state): State<AppState>,
      headers: HeaderMap,
      Json(input): Json<PasteInput>,
  ) -> Result<Json<Value>, ApiError> {
      let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
      let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
      
      // 执行底层粘贴
      let entry = ws::paste_entry(&workspace, &input.path, &input.destination_dir, &input.action)
          .map_err(map_workspace_error)?;

      // 如果是 copy，需要遍历新产生的文件进行 quota 配额扣除以及记录 file_ref
      if input.action == "copy" {
          let target_path = ws::validate_existing_path(&entry.path, &workspace).map_err(map_workspace_error)?;
          if target_path.is_file() {
              if let Ok(bytes) = tokio::fs::read(&target_path).await {
                  assert_workspace_save_within_quota(&state, &user_id, &target_path, bytes.len() as u64).await?;
                  record_file_ref(&state, &user_id, &workspace, &target_path, &ws::mime_type_for_path(&target_path), &bytes, None).await?;
              }
          } else {
              // 目录则递归扫描记录
              let mut walk = walkdir::WalkDir::new(&target_path).into_iter().filter_map(Result::ok);
              while let Some(e) = walk.next() {
                  let p = e.path();
                  if p.is_file() {
                      if let Ok(bytes) = tokio::fs::read(p).await {
                          assert_workspace_save_within_quota(&state, &user_id, p, bytes.len() as u64).await?;
                          record_file_ref(&state, &user_id, &workspace, p, &ws::mime_type_for_path(p), &bytes, None).await?;
                      }
                  }
              }
          }
      } else if input.action == "move" {
          // move 场景只需更新数据库里原本此文件/文件夹下所有文件的 storage_uri
          // 为简单健壮，我们可以根据新路径更新或直接 upsert 一下最终产物。
          let target_path = ws::validate_existing_path(&entry.path, &workspace).map_err(map_workspace_error)?;
          if target_path.is_file() {
              if let Ok(bytes) = tokio::fs::read(&target_path).await {
                  record_file_ref(&state, &user_id, &workspace, &target_path, &ws::mime_type_for_path(&target_path), &bytes, None).await?;
              }
          }
      }

      Ok(Json(serde_json::to_value(entry).unwrap_or_else(|_| json!({}))))
  }
  ```

- [ ] **Step 4: 在路由模块中注册这些新路由**
  修改 `crates/ripple-server/src/api/mod.rs`：
  ```rust
  // 找到这一段：
  .route("/workspace/rename", post(workspace::rename_workspace))
  .route("/workspace/upload", post(workspace::upload_workspace_files))
  // 并在其下方或上方插入：
  .route("/workspace/delete", post(workspace::delete_workspace))
  .route("/workspace/create", post(workspace::create_workspace))
  .route("/workspace/paste", post(workspace::paste_workspace))
  ```

- [ ] **Step 5: 验证编译**
  Run: `cargo check -p ripple-server`
  Expected: PASS

---

### Task 3: 前端 API 对应方法扩展

**Files:**
- Modify: `app/src/lib/api.ts`

- [ ] **Step 1: 新增三个前端 API 请求函数**
  在 `app/src/lib/api.ts` 文件的适当位置（例如 `renameWorkspaceEntry` 和 `saveWorkspaceFile` 附近）增加并导出这三个异步函数：
  ```typescript
  export async function deleteWorkspaceEntry(path: string): Promise<boolean> {
    const res = await fetch(`${API_URL}/workspace/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ path }),
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const detail = await responseDetail(res);
      throw new Error(detail || `Failed to delete entry (${res.status})`);
    }
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
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const detail = await responseDetail(res);
      throw new Error(detail || `Paste failed (${res.status})`);
    }
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
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const detail = await responseDetail(res);
      throw new Error(detail || `Create failed (${res.status})`);
    }
    return (await res.json()) as WorkspaceEntry;
  }
  ```

---

### Task 4: 前端 WorkspaceExplorer UI 与交互核心重构

**Files:**
- Modify: `app/src/components/WorkspaceExplorer.tsx`

- [ ] **Step 1: 导入新 API 和必要的 Lucide 图标**
  在 `app/src/components/WorkspaceExplorer.tsx` 顶部导入新增的图标和接口：
  ```typescript
  import {
    // 现有导入...
    Copy,
    Scissors,
    Clipboard,
    Trash2,
    Plus,
    FilePlus,
    FolderPlus,
    CornerDownLeft,
  } from "lucide-react";
  import {
    // 现有导入...
    deleteWorkspaceEntry,
    pasteWorkspaceEntry,
    createWorkspaceEntry,
  } from "@/lib/api";
  ```

- [ ] **Step 2: 新增剪贴板、右键菜单和新建弹窗状态**
  在 `WorkspaceExplorer` 组件内部，定义状态：
  ```typescript
  // 1. 虚拟剪贴板状态
  const [clipboard, setClipboard] = useState<{
    path: string;
    name: string;
    kind: "file" | "directory";
    action: "copy" | "move";
  } | null>(null);

  // 2. 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    entry: WorkspaceEntry | null; // null 表示在空白背景区点击
  }>({ visible: false, x: 0, y: 0, entry: null });

  // 3. 新建文件/目录状态
  const [creationModal, setCreationModal] = useState<{
    visible: boolean;
    kind: "file" | "directory";
  } | null>(null);
  const [creationDraft, setCreationDraft] = useState("");
  const [creationSaving, setCreationSaving] = useState(false);
  ```

- [ ] **Step 3: 实现新建/删除/复制/剪切/粘贴核心操作逻辑**
  在 `WorkspaceExplorer` 组件内编写业务操作逻辑：
  ```typescript
  // 新建
  const handleCreate = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (!creationModal || creationSaving) return;
    const name = creationDraft.trim();
    if (!name) {
      setCreationModal(null);
      return;
    }
    setCreationSaving(true);
    setError(null);
    try {
      const parentPrefix = currentPath === "/workspace" ? "/workspace" : currentPath;
      const targetPath = `${parentPrefix}/${name}`;
      const newEntry = await createWorkspaceEntry(targetPath, creationModal.kind);
      
      // 更新当前列表视图
      setListing((current) => {
        if (!current) return current;
        return {
          ...current,
          entries: sortWorkspaceEntries([...current.entries, newEntry]),
        };
      });
      setCreationModal(null);
      setCreationDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreationSaving(false);
    }
  };

  // 删除
  const handleDelete = async (entry: WorkspaceEntry) => {
    const confirmed = window.confirm(`Are you sure you want to delete ${entry.name}?`);
    if (!confirmed) return;
    setError(null);
    try {
      await deleteWorkspaceEntry(entry.path);
      // 如果当前正在预览被删除的文件，清除预览
      if (preview?.path === entry.path) {
        setPreview(null);
        setDraft("");
      }
      setListing((current) => {
        if (!current) return current;
        return {
          ...current,
          entries: current.entries.filter((item) => item.path !== entry.path),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 剪切与复制
  const handleCut = (entry: WorkspaceEntry) => {
    setClipboard({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      action: "move",
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handleCopy = (entry: WorkspaceEntry) => {
    setClipboard({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      action: "copy",
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  // 粘贴
  const handlePaste = async () => {
    if (!clipboard) return;
    setError(null);
    try {
      const destination = currentPath;
      const pasted = await pasteWorkspaceEntry(clipboard.path, destination, clipboard.action);
      
      // 如果是剪切，在源文件夹已被移动的情况下清除剪贴板，并将新条目装入列表
      if (clipboard.action === "move") {
        setClipboard(null);
      }
      
      // 重新加载当前目录确保最准
      await loadDirectory(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setContextMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  // 复制相对于沙箱的绝对路径
  const handleCopyAbsoluteSandboxPath = (entry: WorkspaceEntry) => {
    navigator.clipboard.writeText(entry.path);
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };
  ```

- [ ] **Step 4: 注册右键菜单全局关闭和呼出监听**
  ```typescript
  // 注册全局点击关闭 context menu
  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    };
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  const onEntryContextMenu = (event: React.MouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      entry,
    });
  };

  const onContainerContextMenu = (event: React.MouseEvent) => {
    // 只有在点击了空白区域时才呼出全局菜单
    if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("context-trigger-area")) {
      event.preventDefault();
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        entry: null,
      });
    }
  };
  ```

- [ ] **Step 5: 优化底部分栏 Grid 展示逻辑 (未选中文件自适应 100% 高度)**
  修改 `const isPreviewPanelHidden`：
  ```typescript
  // 旧：const isPreviewPanelHidden = splitPercent >= MAX_SPLIT_PERCENT;
  // 新：在没有 preview 时，同样算作完全隐藏，高度收缩，让列表全屏占满！
  const isPreviewPanelHidden = splitPercent >= MAX_SPLIT_PERCENT || !preview;
  ```
  这样，没有选中文件时，在 `style={{ gridTemplateRows: splitGridTemplateRows }}` 作用下，下方的 Grid 列宽会渲染为 `minmax(0,100%) 0px`，列表全高展露！

- [ ] **Step 6: 在列表项中应用“剪切”不透明度样式，并绑定右键**
  在文件/文件夹的渲染行 `visibleEntries.map((entry) => ...`：
  * 为元素增加：`onContextMenu={(event) => onEntryContextMenu(event, entry)}`。
  * 对整个行 div 的类名，通过剪贴板状态追加 `opacity-30` 半透明：
    `const isCutSource = clipboard?.action === "move" && clipboard?.path === entry.path;`
    `className={... ${isCutSource ? "opacity-35 select-none" : ""}}`

- [ ] **Step 7: 渲染自定义 `ContextMenu` 浮动 DOM 和 `CreationModal` 对话框 DOM**
  在组件主 JSX 返回的最底部，加入绝对定位渲染：
  *(确保根据视口大小自适应 x, y 坐标不溢出)*
  ```typescript
  {/* 右键菜单 */}
  {contextMenu.visible && (
    <div
      style={{ top: contextMenu.y, left: contextMenu.x }}
      className="fixed z-50 min-w-[160px] rounded-lg border border-[#e5e7eb] bg-white p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.08)] text-xs text-[#374151]"
      onClick={(e) => e.stopPropagation()}
    >
      {contextMenu.entry ? (
        // 针对文件和文件夹的具体右键操作
        <>
          <button
            type="button"
            onClick={() => {
              if (contextMenu.entry) startRename(contextMenu.entry);
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]"
          >
            <Edit3 size={13} /> Rename
          </button>
          <button
            type="button"
            onClick={() => contextMenu.entry && handleCut(contextMenu.entry)}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]"
          >
            <Scissors size={13} /> Cut (Move)
          </button>
          <button
            type="button"
            onClick={() => contextMenu.entry && handleCopy(contextMenu.entry)}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]"
          >
            <Copy size={13} /> Copy
          </button>
          <button
            type="button"
            onClick={() => contextMenu.entry && handleCopyAbsoluteSandboxPath(contextMenu.entry)}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6] font-[family-name:var(--font-mono)]"
          >
            <FileText size={13} /> Copy Sandbox Path
          </button>
          {contextMenu.entry.kind === "file" && (
            <button
              type="button"
              onClick={() => {
                if (contextMenu.entry) void handleDownloadFile(contextMenu.entry.path);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]"
            >
              <Download size={13} /> Download
            </button>
          )}
          <hr className="my-1 border-[#f3f4f6]" />
          <button
            type="button"
            onClick={() => contextMenu.entry && void handleDelete(contextMenu.entry)}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#ffeef0] text-[#cf222e]"
          >
            <Trash2 size={13} /> Delete
          </button>
        </>
      ) : (
        // 针对空白处的右键操作
        <>
          <button
            type="button"
            disabled={!clipboard}
            onClick={handlePaste}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Clipboard size={13} /> Paste {clipboard ? `(${clipboard.name})` : ""}
          </button>
          <hr className="my-1 border-[#f3f4f6]" />
          <button
            type="button"
            onClick={() => {
              setCreationModal({ visible: true, kind: "file" });
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]"
          >
            <FilePlus size={13} /> New File
          </button>
          <button
            type="button"
            onClick={() => {
              setCreationModal({ visible: true, kind: "directory" });
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[#f3f4f6]"
          >
            <FolderPlus size={13} /> New Folder
          </button>
        </>
      )}
    </div>
  )}

  {/* 新建模态对话框 */}
  {creationModal?.visible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs">
      <form
        onSubmit={handleCreate}
        className="w-80 rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-xl"
      >
        <h3 className="mb-3 text-sm font-semibold text-[#0d0d0d]">
          {creationModal.kind === "file" ? "Create New File" : "Create New Folder"}
        </h3>
        <input
          autoFocus
          value={creationDraft}
          onChange={(e) => setCreationDraft(e.target.value)}
          placeholder={creationModal.kind === "file" ? "e.g. main.py" : "e.g. src_folder"}
          className="mb-4 h-9 w-full rounded-md border border-[#e5e7eb] bg-white px-3 text-sm outline-none focus:border-[#2463eb]"
          disabled={creationSaving}
        />
        <div className="flex justify-end gap-2 text-xs font-medium">
          <button
            type="button"
            onClick={() => {
              setCreationModal(null);
              setCreationDraft("");
            }}
            className="rounded-md border border-[#e5e7eb] bg-white px-3 py-1.5 text-[#374151] hover:bg-[#f9fafb]"
            disabled={creationSaving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-[#2463eb] px-3 py-1.5 text-white hover:bg-[#1d4ed8]"
            disabled={creationSaving}
          >
            {creationSaving ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  )}
  ```

- [ ] **Step 8: 让列表区支持容器空白处右键和点击新建快捷键**
  * 在外层大容器 `<div className="h-full overflow-y-auto pb-10" ...>` 上：
    1. 增加类名：`context-trigger-area`
    2. 增加：`onContextMenu={onContainerContextMenu}`

---

### Task 5: 端到端测试与质量控制

**Files:**
- Test: `app/src/components/WorkspaceExplorer.test.tsx`

- [ ] **Step 1: 验证 React 编译与 Lint 校验**
  Run: `cd app && bun run lint && bun run build`
  Expected: SUCCESS

- [ ] **Step 2: 重启后端服务器并进行功能点验证**
  1. 打开 Ripple 前端界面，切换至 Files。
  2. 观察底部：未选中文件时，默认没有任何 "Select a file" 区域，列表占满底部。
  3. 右键点击背景处，选择 New Folder，建立文件夹 `tests_dir`。
  4. 双击进入 `tests_dir`，右键空白处，选择 New File 建立 `app.py`。
  5. 单击/双击 `app.py`，底部滑出预览并展示，输入编辑保存正常。
  6. 右键 `app.py` 选择 Cut (移动)。
  7. 点击 Up 按钮返回上级目录，右键空白选择 Paste，文件成功被移动。
  8. 右键 `app.py` 选择 Delete，确认后文件消失。
