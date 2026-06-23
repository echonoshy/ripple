# Ripple Navigation

Use this for questions about top tabs, bottom tabs, Settings entry, and page switching.

## Code Sources

- `app/src/lib/workspaceViews.ts`
- `app/src/components/workbench/ProductTopBar.tsx`
- `app/src/components/workbench/MobileTabBar.tsx`

## Desktop Top Bar

Visible clues:

- Ripple logo and product name on the left.
- Center segmented navigation with Sessions, Tasks, Files, Skills.
- Profile/avatar button on the right, often with a small green status dot.

Behavior:

- `mainNavItems` defines the desktop primary tabs: `sessions`, `tasks`, `files`, `skills`.
- In `ProductTopBar.tsx`, each tab has `data-ripple-top-tab={item.id}` and calls `onSelectView(item.id)`.
- Clicking a tab switches the active view. It does not send a message, start a task, run Codex, upload a file, or mutate data by itself.
- The selected tab gets the accent background and underline.
- The right avatar/settings entry uses `data-ripple-top-settings-entry="true"` and calls `onOpenSettings`.

## Mobile Bottom Tab Bar

Visible clues:

- Bottom floating tab bar with Sessions, Tasks, Files, Skills, Settings.
- Icons come from `mobileNavItems`.

Behavior:

- `mobileNavItems` is `mainNavItems` plus `{ id: "home", label: "Settings" }`.
- `MobileTabBar.tsx` calls `onSelectView(item.id)` on tap.
- The tab bar can be hidden for deeper mobile session/detail states using `data-ripple-mobile-tabbar-hidden`.
- Tapping a tab navigates. It does not execute work by itself.

## Inspector Visibility

`shouldShowInspector(view)` returns `true` only for `sessions`.

Use this when a screenshot shows a right-side workspace/inspector panel:

- On Sessions, the inspector can appear because chat often needs workspace/file context.
- On Tasks, Files, Skills, and Settings, the page owns its own layout rather than showing the Sessions inspector.

## How To Answer

If the user asks "what is this tab/button", say:

- It is navigation.
- Which page it opens.
- It is low-risk and view-switching only.
- It may change the visible workspace but should not start execution or change stored task/file state.
