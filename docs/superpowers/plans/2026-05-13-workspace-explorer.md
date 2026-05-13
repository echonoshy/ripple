# Workspace Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Workspace tab to the right panel so the current user can browse and preview files in their sandbox workspace.

**Architecture:** Backend path validation and file inspection live in a focused `interfaces.server.workspace_browser` module. `routes.py` only wires two authenticated user-scoped endpoints to that module. The Next.js client adds typed API helpers and a `WorkspaceExplorer` component that is shown as a tab beside the current task/terminal activity panel.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, pytest, TypeScript, React, Next.js, lucide-react, existing Ripple CSS utilities.

---

### Task 1: Backend Workspace Browser Module

**Files:**
- Create: `src/interfaces/server/workspace_browser.py`
- Modify: `src/interfaces/server/schemas.py`
- Test: `tests/test_workspace_browser.py`

- [ ] **Step 1: Write failing tests for directory listing and path safety**

Create `tests/test_workspace_browser.py` with:

```python
from pathlib import Path

import pytest

from interfaces.server.workspace_browser import (
    BinaryFileError,
    browse_workspace_directory,
    preview_workspace_file,
)


def test_browse_workspace_directory_sorts_directories_before_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "zeta.txt").write_text("z", encoding="utf-8")
    (workspace / "alpha").mkdir()
    (workspace / ".config").mkdir()
    (workspace / "beta.md").write_text("b", encoding="utf-8")

    listing = browse_workspace_directory(workspace, "/workspace")

    assert listing.path == "/workspace"
    assert listing.parent_path is None
    assert [entry.name for entry in listing.entries] == [".config", "alpha", "beta.md", "zeta.txt"]
    assert [entry.kind for entry in listing.entries] == ["directory", "directory", "file", "file"]
    assert listing.entries[0].is_hidden is True
    assert listing.entries[2].path == "/workspace/beta.md"


def test_browse_workspace_directory_supports_nested_relative_paths(tmp_path: Path):
    workspace = tmp_path / "workspace"
    nested = workspace / "src" / "app"
    nested.mkdir(parents=True)
    (nested / "page.tsx").write_text("export default null", encoding="utf-8")

    listing = browse_workspace_directory(workspace, "src/app")

    assert listing.path == "/workspace/src/app"
    assert listing.parent_path == "/workspace/src"
    assert [entry.path for entry in listing.entries] == ["/workspace/src/app/page.tsx"]


def test_browse_workspace_directory_rejects_symlink_escape(tmp_path: Path):
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)

    with pytest.raises(PermissionError):
        browse_workspace_directory(workspace, "/workspace/escape")
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/test_workspace_browser.py -q
```

Expected: import error for `interfaces.server.workspace_browser`.

- [ ] **Step 3: Add schemas**

Add these Pydantic models to `src/interfaces/server/schemas.py` near the sandbox models:

```python
class WorkspaceEntry(BaseModel):
    name: str
    path: str
    kind: Literal["directory", "file"]
    size_bytes: int
    modified_at: str
    is_hidden: bool = False


class WorkspaceListingResponse(BaseModel):
    path: str
    parent_path: str | None = None
    entries: list[WorkspaceEntry] = []


class WorkspaceFilePreviewResponse(BaseModel):
    path: str
    name: str
    size_bytes: int
    modified_at: str
    mime_type: str
    encoding: str
    content: str
    truncated: bool = False
```

- [ ] **Step 4: Implement the browser module**

Create `src/interfaces/server/workspace_browser.py`:

```python
import mimetypes
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from interfaces.server.schemas import (
    WorkspaceEntry,
    WorkspaceFilePreviewResponse,
    WorkspaceListingResponse,
)
from ripple.sandbox.workspace import SANDBOX_VIRTUAL_ROOT, validate_path

DEFAULT_PREVIEW_LIMIT_BYTES = 64 * 1024
MAX_PREVIEW_LIMIT_BYTES = 256 * 1024


class BinaryFileError(ValueError):
    pass


@dataclass(frozen=True)
class ResolvedWorkspacePath:
    host_path: Path
    virtual_path: str


def browse_workspace_directory(workspace_root: Path, requested_path: str | Path = SANDBOX_VIRTUAL_ROOT) -> WorkspaceListingResponse:
    resolved = _resolve_workspace_path(workspace_root, requested_path)
    if not resolved.host_path.exists():
        raise FileNotFoundError(resolved.virtual_path)
    if not resolved.host_path.is_dir():
        raise NotADirectoryError(resolved.virtual_path)

    entries = [_entry_for_path(workspace_root, child) for child in resolved.host_path.iterdir()]
    entries.sort(key=lambda entry: (entry.kind != "directory", entry.name.lower()))

    return WorkspaceListingResponse(
        path=resolved.virtual_path,
        parent_path=_parent_virtual_path(resolved.virtual_path),
        entries=entries,
    )


def preview_workspace_file(
    workspace_root: Path,
    requested_path: str | Path,
    *,
    limit_bytes: int = DEFAULT_PREVIEW_LIMIT_BYTES,
) -> WorkspaceFilePreviewResponse:
    resolved = _resolve_workspace_path(workspace_root, requested_path)
    if not resolved.host_path.exists():
        raise FileNotFoundError(resolved.virtual_path)
    if not resolved.host_path.is_file():
        raise IsADirectoryError(resolved.virtual_path)

    limit = max(1, min(limit_bytes, MAX_PREVIEW_LIMIT_BYTES))
    stat = resolved.host_path.stat()
    raw = resolved.host_path.read_bytes()[: limit + 1]
    if _looks_binary(raw):
        raise BinaryFileError(resolved.virtual_path)

    truncated = len(raw) > limit or stat.st_size > limit
    content = raw[:limit].decode("utf-8", errors="replace")
    mime_type = mimetypes.guess_type(resolved.host_path.name)[0] or "text/plain"

    return WorkspaceFilePreviewResponse(
        path=resolved.virtual_path,
        name=resolved.host_path.name,
        size_bytes=stat.st_size,
        modified_at=_format_mtime(stat.st_mtime),
        mime_type=mime_type,
        encoding="utf-8",
        content=content,
        truncated=truncated,
    )


def _resolve_workspace_path(workspace_root: Path, requested_path: str | Path) -> ResolvedWorkspacePath:
    host_path = validate_path(requested_path, workspace_root)
    return ResolvedWorkspacePath(host_path=host_path, virtual_path=_virtual_path(workspace_root, host_path))


def _entry_for_path(workspace_root: Path, path: Path) -> WorkspaceEntry:
    stat = path.stat()
    kind = "directory" if path.is_dir() else "file"
    return WorkspaceEntry(
        name=path.name,
        path=_virtual_path(workspace_root, path),
        kind=kind,
        size_bytes=0 if kind == "directory" else stat.st_size,
        modified_at=_format_mtime(stat.st_mtime),
        is_hidden=path.name.startswith("."),
    )


def _virtual_path(workspace_root: Path, host_path: Path) -> str:
    relative = host_path.resolve().relative_to(workspace_root.resolve())
    if str(relative) == ".":
        return str(SANDBOX_VIRTUAL_ROOT)
    return str(SANDBOX_VIRTUAL_ROOT / relative)


def _parent_virtual_path(virtual_path: str) -> str | None:
    path = Path(virtual_path)
    if path == SANDBOX_VIRTUAL_ROOT:
        return None
    parent = path.parent
    if parent == Path("/"):
        return str(SANDBOX_VIRTUAL_ROOT)
    return str(parent)


def _format_mtime(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat()


def _looks_binary(raw: bytes) -> bool:
    if not raw:
        return False
    if b"\x00" in raw:
        return True
    sample = raw[:1024]
    control_count = sum(1 for byte in sample if byte < 32 and byte not in (9, 10, 13))
    return control_count / len(sample) > 0.30
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
uv run pytest tests/test_workspace_browser.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Add preview tests**

Append to `tests/test_workspace_browser.py`:

```python
def test_preview_workspace_file_returns_truncated_text(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.md").write_text("hello world", encoding="utf-8")

    preview = preview_workspace_file(workspace, "/workspace/notes.md", limit_bytes=5)

    assert preview.path == "/workspace/notes.md"
    assert preview.name == "notes.md"
    assert preview.content == "hello"
    assert preview.truncated is True
    assert preview.encoding == "utf-8"


def test_preview_workspace_file_rejects_binary_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "image.bin").write_bytes(b"\x00\x01\x02\x03")

    with pytest.raises(BinaryFileError):
        preview_workspace_file(workspace, "/workspace/image.bin")
```

- [ ] **Step 7: Run preview tests**

Run:

```bash
uv run pytest tests/test_workspace_browser.py -q
```

Expected: all tests pass.

### Task 2: Backend API Routes

**Files:**
- Modify: `src/interfaces/server/routes.py`
- Test: `tests/test_workspace_routes.py`

- [ ] **Step 1: Write failing route tests**

Create `tests/test_workspace_routes.py`:

```python
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from interfaces.server.routes import router, set_session_manager
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


class DummySessionManager:
    def __init__(self, sandbox_manager):
        self.sandbox_manager = sandbox_manager


def _client(tmp_path: Path, user_id: str = "alice") -> tuple[TestClient, SandboxManager]:
    config = SandboxConfig(sandboxes_root=tmp_path / "sandboxes", caches_root=tmp_path / "cache")
    sandbox_manager = SandboxManager(config)
    app = FastAPI()
    app.include_router(router)
    set_session_manager(DummySessionManager(sandbox_manager))
    return TestClient(app, headers={"X-Ripple-User-Id": user_id}), sandbox_manager


def test_workspace_route_lists_current_user_workspace(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "src").mkdir()
    (workspace / "README.md").write_text("# Hello", encoding="utf-8")

    response = client.get("/v1/workspace")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "/workspace"
    assert [entry["name"] for entry in body["entries"]] == ["src", "README.md"]


def test_workspace_route_returns_404_before_sandbox_exists(tmp_path: Path):
    client, _sandbox_manager = _client(tmp_path)

    response = client.get("/v1/workspace")

    assert response.status_code == 404


def test_workspace_file_route_previews_text(tmp_path: Path):
    client, sandbox_manager = _client(tmp_path)
    workspace = sandbox_manager.ensure_sandbox("alice")
    (workspace / "notes.txt").write_text("abcdef", encoding="utf-8")

    response = client.get("/v1/workspace/file", params={"path": "/workspace/notes.txt", "limit": 3})

    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "abc"
    assert body["truncated"] is True
```

- [ ] **Step 2: Run route tests to verify they fail**

Run:

```bash
uv run pytest tests/test_workspace_routes.py -q
```

Expected: 404 for missing `/v1/workspace` route.

- [ ] **Step 3: Wire routes**

Modify imports in `src/interfaces/server/routes.py` to include:

```python
from interfaces.server.workspace_browser import (
    BinaryFileError,
    browse_workspace_directory,
    preview_workspace_file,
)
```

Add route handlers after the existing sandbox routes:

```python
@router.get("/v1/workspace")
async def list_workspace(
    path: str = Query(default="/workspace"),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    try:
        return browse_workspace_directory(workspace_root, path)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except NotADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a directory") from e


@router.get("/v1/workspace/file")
async def get_workspace_file(
    path: str = Query(...),
    limit: int = Query(default=64 * 1024, ge=1, le=256 * 1024),
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")
    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        raise HTTPException(status_code=404, detail=f"Sandbox for user {user_id!r} not found")
    try:
        return preview_workspace_file(workspace_root, path, limit_bytes=limit)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Path not found") from e
    except IsADirectoryError as e:
        raise HTTPException(status_code=400, detail="Path is not a file") from e
    except BinaryFileError as e:
        raise HTTPException(status_code=415, detail="Binary files cannot be previewed") from e
```

- [ ] **Step 4: Run route tests**

Run:

```bash
uv run pytest tests/test_workspace_browser.py tests/test_workspace_routes.py -q
```

Expected: all tests pass.

### Task 3: Frontend Types and API Helpers

**Files:**
- Modify: `src/interfaces/web/src/types/index.ts`
- Modify: `src/interfaces/web/src/lib/api.ts`

- [ ] **Step 1: Add workspace types**

Add to `src/interfaces/web/src/types/index.ts`:

```ts
export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size_bytes: number;
  modified_at: string;
  is_hidden: boolean;
}

export interface WorkspaceListing {
  path: string;
  parent_path: string | null;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFilePreview {
  path: string;
  name: string;
  size_bytes: number;
  modified_at: string;
  mime_type: string;
  encoding: string;
  content: string;
  truncated: boolean;
}
```

- [ ] **Step 2: Add API helpers**

Update the type import in `src/interfaces/web/src/lib/api.ts` to include `WorkspaceFilePreview` and `WorkspaceListing`.

Add:

```ts
function encodeWorkspacePath(path: string): string {
  return encodeURIComponent(path || "/workspace");
}

export async function fetchWorkspaceListing(path: string = "/workspace"): Promise<WorkspaceListing> {
  const res = await fetch(`${API_URL}/workspace?path=${encodeWorkspacePath(path)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch workspace (${res.status})`);
  return (await res.json()) as WorkspaceListing;
}

export async function fetchWorkspaceFilePreview(
  path: string,
  limit: number = 64 * 1024
): Promise<WorkspaceFilePreview> {
  const qs = new URLSearchParams({ path, limit: String(limit) });
  const res = await fetch(`${API_URL}/workspace/file?${qs.toString()}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to preview file (${res.status})`);
  return (await res.json()) as WorkspaceFilePreview;
}
```

- [ ] **Step 3: Type check through build tooling**

Run:

```bash
cd src/interfaces/web && bun run lint
```

Expected: lint completes without TypeScript or ESLint errors from these helpers.

### Task 4: Right Panel Workspace Tab

**Files:**
- Create: `src/interfaces/web/src/components/WorkspaceExplorer.tsx`
- Modify: `src/interfaces/web/src/app/page.tsx`

- [ ] **Step 1: Create `WorkspaceExplorer`**

Create `src/interfaces/web/src/components/WorkspaceExplorer.tsx` with a client component that imports `Folder`, `FileText`, `RefreshCw`, `ArrowUp`, `Loader2`, and `AlertTriangle` from `lucide-react`, imports `fetchWorkspaceFilePreview` and `fetchWorkspaceListing`, and renders:

```tsx
export default function WorkspaceExplorer({ userId, refreshToken }: WorkspaceExplorerProps) {
  const [currentPath, setCurrentPath] = useState("/workspace");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkspaceListing(path);
      setListing(data);
      setCurrentPath(data.path);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory, refreshToken, userId]);

  const openEntry = async (entry: WorkspaceEntry) => {
    if (entry.kind === "directory") {
      await loadDirectory(entry.path);
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await fetchWorkspaceFilePreview(entry.path));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="bg-ripple-sidebar flex h-full flex-col overflow-hidden">
      {/* header, path row, directory list, and preview */}
    </div>
  );
}
```

The final component must include:

- Refresh button calling `loadDirectory(currentPath)`.
- Parent button when `listing?.parent_path` is present.
- Empty state when `listing.entries.length === 0`.
- File preview in a `<pre>` with `whitespace-pre-wrap`.
- A truncation badge when `preview.truncated` is true.
- Error banner with `AlertTriangle`.

- [ ] **Step 2: Add right panel tabs in `page.tsx`**

Modify imports in `src/interfaces/web/src/app/page.tsx`:

```tsx
import { Activity, FolderOpen } from "lucide-react";
import WorkspaceExplorer from "@/components/WorkspaceExplorer";
```

Add state:

```tsx
const [rightPanelTab, setRightPanelTab] = useState<"activity" | "workspace">("activity");
const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
```

In `onComplete`, after `loadSessions();`, add:

```tsx
setWorkspaceRefreshToken((prev) => prev + 1);
```

Replace the right `<aside>` body with tab buttons and conditional content:

```tsx
<div className="border-ripple-ink bg-ripple-yellow flex shrink-0 gap-2 border-b-2 p-2">
  <button type="button" onClick={() => setRightPanelTab("activity")} className={rightPanelTab === "activity" ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}>
    <Activity size={13} />
    Activity
  </button>
  <button type="button" onClick={() => setRightPanelTab("workspace")} className={rightPanelTab === "workspace" ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}>
    <FolderOpen size={13} />
    Workspace
  </button>
</div>
<div className="min-h-0 flex-1 overflow-hidden">
  {rightPanelTab === "activity" ? (
    <TaskExecutionPanel tasks={tasks} taskProgress={taskProgress} toolCalls={allToolCalls} isGenerating={isGenerating} />
  ) : (
    <WorkspaceExplorer userId={userId} refreshToken={workspaceRefreshToken} />
  )}
</div>
```

- [ ] **Step 3: Run frontend validation**

Run:

```bash
cd src/interfaces/web && bun run lint
```

Expected: lint passes.

Run:

```bash
cd src/interfaces/web && bun run build
```

Expected: build passes.

### Task 5: Formatting and Focused Verification

**Files:**
- Modify: files touched in Tasks 1-4 if formatters change them.

- [ ] **Step 1: Format Python and frontend files**

Run:

```bash
uv run ruff format src/interfaces/server/workspace_browser.py src/interfaces/server/schemas.py src/interfaces/server/routes.py tests/test_workspace_browser.py tests/test_workspace_routes.py
cd src/interfaces/web && bun run format
```

Expected: formatters complete.

- [ ] **Step 2: Run lint checks**

Run:

```bash
uv run ruff check src/interfaces/server/workspace_browser.py src/interfaces/server/schemas.py src/interfaces/server/routes.py tests/test_workspace_browser.py tests/test_workspace_routes.py
cd src/interfaces/web && bun run lint
```

Expected: no lint errors from changed files.

- [ ] **Step 3: Run focused tests**

Run:

```bash
uv run pytest tests/test_workspace_browser.py tests/test_workspace_routes.py -q
```

Expected: all workspace tests pass.

- [ ] **Step 4: Run frontend build**

Run:

```bash
cd src/interfaces/web && bun run build
```

Expected: Next.js build passes.
