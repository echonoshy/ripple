# 用户身份卡片气泡菜单实施计划 (User Profile Popover Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor bottom User Profile Card to pop up a comprehensive Sandbox Status popover with user-switching, quotas, and usage placeholders, while pruning the settings modal redundancy.

**Architecture:**
- Extend backend axum `/v1/users/me` profile endpoint to embed sandbox storage, runs, and session quota info.
- Implement Popover UI overlay backdrop in `WorkspaceNav.tsx` with dynamic usage progress meters.
- Shift `onUserIdChange` directly into `WorkspaceNavProps` to drive inline user-switching.

---

### Task 1: Extend Backend axum User Profile and Add Frontend fetch API

**Files:**
- Modify: `crates/ripple-server/src/api/users.rs`
- Modify: `app/src/lib/api.ts`

- [ ] **Step 1: Embed usage in backend user profile response**
  Modify `current_user_profile` in `crates/ripple-server/src/api/users.rs` to fetch user usage and add it to the JSON response:

```rust
pub async fn current_user_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let usage = user_usage(&state, &user_id).await.unwrap_or(json!({}));
    Ok(Json(json!({
        "user_id": user_id,
        "auth": auth.public_json(),
        "usage": usage
    })))
}
```

Verify backend builds and tests pass:
```bash
cargo check -p ripple-server
cargo test -p ripple-server
```

- [ ] **Step 2: Add fetchUserProfile inside frontend API helper**
  Declare `fetchUserProfile` in `app/src/lib/api.ts` to query `/users/me`:

```typescript
export async function fetchUserProfile(): Promise<{
  user_id: string;
  usage?: {
    workspace_size_bytes: number;
    session_count: number;
    runs_today: number;
    active_runs: number;
  };
}> {
  const res = await fetch(`${API_URL}/users/me`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to fetch user profile");
  return (await res.json()) as any;
}
```

---

### Task 2: Implement User Popover and Inline Switching State inside WorkspaceNav

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.tsx`
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/workbench/WorkspaceNav.test.tsx`

- [ ] **Step 1: Propagate onUserIdChange via Props**
  Modify `WorkspaceNavProps` in `app/src/components/workbench/WorkspaceNav.tsx` to include `onUserIdChange: (userId: string) => void` and remove the now unnecessary `onOpenSettings` prop (or keep it if it's still needed, but since we have a dedicated gear settings button, let's keep `onOpenSettings` on WorkspaceNav since the Gear settings icon at the top of the sidebar calls it, but remove settings opening from the bottom card click).

  Also propagate `onUserIdChange` inside `<WorkspaceNav ...>` instantiations in `app/src/App.tsx` and standard mock properties in `app/src/components/workbench/WorkspaceNav.test.tsx`.

- [ ] **Step 2: Declare Popover States inside WorkspaceNav**
  Add states:
  * `isUserMenuOpen`: boolean
  * `isSwitchingUser`: boolean
  * `newUserDraft`: string
  * `userUsageData`: any | null

  And on mount or when `isUserMenuOpen` transitions to true, call `fetchUserProfile` to load quota data.

- [ ] **Step 3: Update Click-outside Backdrop overlay**
  In the top backdrop section, ensure clicking shuts both session menu AND user menu:
  ```typescript
  const isBackdropVisible = Boolean(activeMenuSessionId || isUserMenuOpen);
  // ...
  {isBackdropVisible && (
    <div
      className="fixed inset-0 z-40 bg-transparent"
      onClick={() => {
        setActiveMenuSessionId(null);
        setIsUserMenuOpen(false);
      }}
    />
  )}
  ```

---

### Task 3: Design the User Popover UI and Inline User Input Form

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.tsx`

- [ ] **Step 1: Build popover card**
  When `isUserMenuOpen` is true, render a beautiful top-popping popover at `absolute bottom-14 left-3 z-50 w-64`:
  - A green status pulse indicator with the title "Sandbox Status".
  - **Disk Usage** meter: Max `2048 MB` (2 GB). Calculate percent: `((usage.workspace_size_bytes) / (2048 * 1024 * 1024)) * 100`. Render a neat progress bar using `<div className="h-1 w-full bg-[#e5e7eb] rounded-full overflow-hidden"><div className="bg-[#2463eb] h-full" style={{ width: ... }} /></div>`. Show human-readable bytes (e.g., `24.5 KB of 2 GB`).
  - **Active Sessions** meter: Max `200`. Percentage: `(usage.session_count / 200) * 100`.
  - **Token Usage** section: Render an elegant card block with a placeholder showing `Token usage: ~k tokens`.
  - **Switch User** trigger button: A clean action button at the bottom of the popover which triggers `isSwitchingUser(true)` and closes the menu.

- [ ] **Step 2: Build Inline User Switcher Form**
  When `isSwitchingUser` is true, render a neat input in place of the bottom avatar profile:
  - An inline `<form>` that takes user input with a text `<input>` prefilled with `userId`.
  - Display a clean `Check` action icon (to save) and an `X` (to cancel).
  - Add Escape, blur (save), and Enter handlers to complete switching safely.

---

### Task 4: Testing and Lint Refinement

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.test.tsx`

- [ ] **Step 1: Run and Add Tests**
  Run frontend test suite:
  ```bash
  bun run app/src/components/workbench/WorkspaceNav.test.tsx
  bun run app/src/components/workbench/SessionPage.test.tsx
  ```
  Ensure all tests pass.
  Verify compiling: `bun run tsc -b` and `eslint` check: `bun run lint`.
