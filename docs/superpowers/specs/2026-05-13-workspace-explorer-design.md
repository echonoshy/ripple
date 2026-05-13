# Workspace Explorer Design

## Goal

Expose the current user's sandbox workspace in the web UI so users can see what Ripple and its tools have created. The first version is read-only and lives in the existing resizable right panel as a `Workspace` tab next to task and terminal output.

## Scope

The first version includes:

- A user-scoped API for listing workspace directory entries.
- A user-scoped API for reading previewable text files.
- A right-panel `Workspace` tab with refresh, breadcrumb-style path display, directory navigation, file metadata, and text preview.
- Empty, loading, error, and sandbox-not-created states.

The first version does not include editing, upload, download, rename, delete, drag and drop, binary preview, search, or watch-mode live updates.

## Backend Design

Add workspace browsing endpoints under the existing authenticated, user-scoped API:

- `GET /v1/workspace?path=<path>` lists one directory.
- `GET /v1/workspace/file?path=<path>&limit=<bytes>` returns a text preview for one file.

Both endpoints use `X-Ripple-User-Id` through the existing `get_user_id` dependency and `verify_api_key`. They require `SessionManager.sandbox_manager`; if sandboxing is disabled they return `500`. If the user sandbox does not exist, they return `404`.

Path handling uses `ripple.sandbox.workspace.validate_path`, so callers may pass relative paths or `/workspace/...` virtual paths but cannot escape the current user's workspace through `..` segments or symlinks.

Directory responses include:

- `path`: normalized virtual path, such as `/workspace` or `/workspace/src`.
- `parent_path`: virtual parent path, or `null` at the workspace root.
- `entries`: sorted directories first, then files by lowercase name.
- Per entry metadata: `name`, `path`, `kind`, `size_bytes`, `modified_at`, and `is_hidden`.

File preview responses include:

- `path`, `name`, `size_bytes`, `modified_at`, `mime_type`, `encoding`, `content`, and `truncated`.
- Text files are decoded as UTF-8 with replacement for invalid bytes.
- Binary-looking files return a clear unsupported error instead of raw bytes.
- Preview size is capped server-side to keep responses small.

Hidden files are visible in the first version because many workspace artifacts, such as `.config`, `.venv`, and tool caches, are useful for understanding the environment. Sensitive credentials stored outside the workspace under `credentials/` remain unreachable. The UI should make hidden/system entries visually quieter.

## Frontend Design

Reuse the existing right panel and add tabs:

- `Activity`: current `TaskExecutionPanel` behavior.
- `Workspace`: new workspace explorer.

On desktop, the right panel remains resizable. On mobile, the existing compact task panel can stay focused on activity for the first version; workspace browsing appears in the desktop right panel only.

The `WorkspaceExplorer` component owns:

- Current path, selected file path, directory listing, file preview, loading state, and error state.
- `Refresh` action for the current directory.
- Directory row click to navigate into a folder.
- File row click to load the preview.
- Parent navigation when not at `/workspace`.

Visual treatment follows the existing Ripple UI: compact rows, square brutalist borders, lucide icons for folder/file/refresh, and no explanatory marketing copy inside the app.

## Data Flow

1. The user opens the `Workspace` tab.
2. The frontend calls `GET /v1/workspace?path=/workspace`.
3. The backend resolves the path against the current user's workspace and returns entries.
4. Clicking a directory repeats the list request for that path.
5. Clicking a file calls `GET /v1/workspace/file`.
6. The frontend shows the file preview or a concise unsupported/error state.

The explorer also refreshes after chat completion so files created by an agent run are visible without changing users or sessions.

## Error Handling

- `404 sandbox not found`: show a state telling the user to create or start a session for the current user.
- `404 path not found`: keep the previous path visible and show a recoverable error.
- `400 not a directory` or `400 not a file`: show a concise inline error.
- `413 preview too large` is not needed because previews are capped and returned with `truncated=true`.
- `403/400 path escape`: show access denied without exposing host paths.
- `401`: reuse existing `AuthError` behavior and return to API key entry.

Backend errors should not leak host filesystem paths. Responses use virtual `/workspace` paths.

## Testing

Backend tests cover:

- Listing root entries for the current user.
- Sorting directories before files.
- Listing nested directories through relative and `/workspace` paths.
- Rejecting path traversal and symlink escape attempts.
- Returning file previews with truncation.
- Rejecting binary previews.
- Returning `404` when the sandbox does not exist.

Frontend tests cover API helpers for auth headers and response parsing if the current test setup supports them. Manual verification covers the right-panel tab behavior, refresh, directory navigation, file preview, empty workspace state, and auth/user switching.
