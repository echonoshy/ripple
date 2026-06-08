# Feishu Design Language Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Ripple Web and mobile UI around the approved Feishu/Lark-style collaborative workbench design language while preserving the existing app structure and Ripple logo.

**Architecture:** Treat `app/src/components/workbench/stylePrimitives.ts` as the local design-token entrypoint, then migrate repeated page chrome and component class strings toward those shared workbench primitives. Implement in visual batches so shell/navigation, session, workspace, and secondary pages can be tested independently without changing backend behavior or frontend information architecture.

**Tech Stack:** Vite, React 19, TypeScript, Tailwind CSS class strings, lucide-react, framer-motion, Bun test/lint/build.

---

## Spec

Use [docs/superpowers/specs/2026-06-08-feishu-design-language-unification-design.md](/home/lake/workspace/ripple/docs/superpowers/specs/2026-06-08-feishu-design-language-unification-design.md) as the source of truth.

## File Map

- Modify `app/src/components/workbench/stylePrimitives.ts`: add workbench-named primitives for surfaces, buttons, fields, menus, status tags, icon buttons, z-index, and shadows; keep temporary aliases for existing imports.
- Modify `app/src/components/workbench/stylePrimitives.test.ts`: update tests from old glass expectations to Feishu-style workbench expectations.
- Modify `app/src/components/workbench/WorkbenchShell.tsx` and `WorkbenchShell.test.tsx`: replace glass edge handle styling with shared workbench primitives.
- Modify `app/src/components/workbench/ProductTopBar.tsx` and `ProductTopBar.test.tsx`: reduce top bar blur/shadow, replace strong blue selected pills with soft selected tab treatment and a 2px bottom indicator.
- Modify `app/src/components/workbench/MobileTabBar.tsx` and `MobileTabBar.test.tsx`: keep bottom tab structure, reduce heavy shadow and one-off radius, use shared mobile navigation primitives.
- Modify `app/src/components/workbench/WorkspaceNav.tsx` and `WorkspaceNav.test.tsx`: solid side rail, subtle selected rows, reduced primary button shadow, shared menu classes.
- Modify `app/src/components/workbench/SessionPage.tsx`, `SessionComposer.tsx`, `SessionTimeline.tsx`, and their tests: normalize chat chrome, notices, token badges, composer shell, icon buttons, and warning surfaces.
- Modify `app/src/components/MarkdownRenderer.tsx` and `MarkdownRenderer.test.tsx`: normalize connector auth/status cards from glass cards to workbench notice/card primitives.
- Modify `app/src/components/WorkspaceExplorer.tsx`, `app/src/components/workspace/*.tsx`, and relevant workspace tests: normalize file browser chrome, toolbar buttons, context menus, confirm/create dialogs, selection bars, and preview headers.
- Modify `app/src/components/workbench/SkillsPage.tsx`, `ConnectorsPage.tsx`, `AutomationsPage.tsx`, `SettingsPage.tsx`, and their tests: unify page shell, cards, primary actions, filters, forms, status tags, and mobile sheets.
- Inspect `app/src/components/AuthGateway.tsx` after main workbench changes; only touch it if shared primitives can be adopted without changing the entry-page structure.

## Task 1: Shared Workbench Primitives

**Files:**
- Modify: `app/src/components/workbench/stylePrimitives.ts`
- Modify: `app/src/components/workbench/stylePrimitives.test.ts`

- [ ] **Step 1: Replace old glass-focused primitive assertions with workbench assertions**

  In `app/src/components/workbench/stylePrimitives.test.ts`, import these new constants:

  ```ts
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_SURFACE_CLASS,
  WORKBENCH_SECTION_CLASS,
  WORKBENCH_FLOATING_SURFACE_CLASS,
  WORKBENCH_TOP_BAR_CLASS,
  WORKBENCH_ICON_BUTTON_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
  WORKBENCH_GHOST_BUTTON_CLASS,
  WORKBENCH_DANGER_BUTTON_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_MENU_CLASS,
  WORKBENCH_MENU_ITEM_CLASS,
  WORKBENCH_MENU_DANGER_ITEM_CLASS,
  WORKBENCH_STATUS_SUCCESS_CLASS,
  WORKBENCH_STATUS_WARNING_CLASS,
  WORKBENCH_STATUS_DANGER_CLASS,
  WORKBENCH_STATUS_NEUTRAL_CLASS,
  ```

  Add assertions:

  ```ts
  assert.equal(WORKBENCH_PAGE_BACKGROUND_CLASS, "bg-[#F5F6F7]");
  assert.match(WORKBENCH_SURFACE_CLASS, /bg-white/);
  assert.match(WORKBENCH_SURFACE_CLASS, /border-\[#DEE0E3\]/);
  assert.doesNotMatch(WORKBENCH_SURFACE_CLASS, /backdrop-blur/);
  assert.doesNotMatch(WORKBENCH_SURFACE_CLASS, /bg-white\/8/);
  assert.match(WORKBENCH_FLOATING_SURFACE_CLASS, /shadow-\[0_12px_32px_rgba\(31,35,41,0\.14\)\]/);
  assert.match(WORKBENCH_TOP_BAR_CLASS, /border-b/);
  assert.match(WORKBENCH_TOP_BAR_CLASS, /bg-white/);
  assert.doesNotMatch(WORKBENCH_TOP_BAR_CLASS, /backdrop-blur/);
  assert.match(WORKBENCH_ICON_BUTTON_CLASS, /h-8 w-8/);
  assert.match(WORKBENCH_ICON_BUTTON_CLASS, /rounded-lg/);
  assert.match(WORKBENCH_MOBILE_ICON_BUTTON_CLASS, /h-11 w-11/);
  assert.match(WORKBENCH_MOBILE_ICON_BUTTON_CLASS, /rounded-xl/);
  assert.match(WORKBENCH_PRIMARY_BUTTON_CLASS, /bg-\[#1456F0\]/);
  assert.match(WORKBENCH_SECONDARY_BUTTON_CLASS, /border-\[#DEE0E3\]/);
  assert.match(WORKBENCH_FIELD_CLASS, /focus:border-\[#1456F0\]/);
  assert.match(WORKBENCH_MENU_CLASS, /rounded-xl/);
  assert.match(WORKBENCH_MENU_ITEM_CLASS, /h-8/);
  assert.match(WORKBENCH_MENU_DANGER_ITEM_CLASS, /text-\[#B42318\]/);
  assert.match(WORKBENCH_STATUS_SUCCESS_CLASS, /text-\[#16845B\]/);
  assert.match(WORKBENCH_STATUS_WARNING_CLASS, /text-\[#8B5E00\]/);
  assert.match(WORKBENCH_STATUS_DANGER_CLASS, /text-\[#B42318\]/);
  assert.match(WORKBENCH_STATUS_NEUTRAL_CLASS, /text-\[#646A73\]/);
  ```

- [ ] **Step 2: Run the primitive test and verify it fails**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/stylePrimitives.test.ts
  ```

  Expected: FAIL because the new `WORKBENCH_*` primitives do not exist yet.

- [ ] **Step 3: Add the shared workbench primitives**

  In `stylePrimitives.ts`, add these exports after the color constants:

  ```ts
  export const WORKBENCH_PAGE_BACKGROUND_CLASS = "bg-[#F5F6F7]";
  export const WORKBENCH_SURFACE_CLASS =
    "border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]";
  export const WORKBENCH_SECTION_CLASS =
    "rounded-xl border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]";
  export const WORKBENCH_FLOATING_SURFACE_CLASS =
    "rounded-xl border border-[#DEE0E3] bg-white shadow-[0_12px_32px_rgba(31,35,41,0.14)]";
  export const WORKBENCH_TOP_BAR_CLASS =
    "border-b border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]";
  export const WORKBENCH_ICON_BUTTON_CLASS =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#DEE0E3] bg-white text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50";
  export const WORKBENCH_MOBILE_ICON_BUTTON_CLASS =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#DEE0E3] bg-white text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] active:bg-[#EFF0F1] disabled:cursor-not-allowed disabled:opacity-50";
  export const WORKBENCH_PRIMARY_BUTTON_CLASS =
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#1456F0] px-3 text-white transition-colors hover:bg-[#0F4BD8] disabled:cursor-not-allowed disabled:bg-[#EFF0F1] disabled:text-[#8F959E]";
  export const WORKBENCH_SECONDARY_BUTTON_CLASS =
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#DEE0E3] bg-white px-3 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50";
  export const WORKBENCH_GHOST_BUTTON_CLASS =
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-transparent px-3 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50";
  export const WORKBENCH_DANGER_BUTTON_CLASS =
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#FAD4D4] bg-white px-3 text-[#B42318] transition-colors hover:bg-[#FFF1F0] disabled:cursor-not-allowed disabled:opacity-50";
  export const WORKBENCH_FIELD_CLASS =
    "rounded-lg border border-[#DEE0E3] bg-white text-[#1F2329] outline-none transition-colors focus:border-[#1456F0] disabled:cursor-not-allowed disabled:bg-[#F8F9FA] disabled:text-[#8F959E]";
  export const WORKBENCH_MENU_CLASS =
    "rounded-xl border border-[#DEE0E3] bg-white p-1 shadow-[0_12px_32px_rgba(31,35,41,0.14)]";
  export const WORKBENCH_MENU_ITEM_CLASS =
    "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] active:bg-[#EFF0F1]";
  export const WORKBENCH_MENU_DANGER_ITEM_CLASS =
    "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[#B42318] transition-colors hover:bg-[#FFF1F0] active:bg-[#FFE3E0]";
  export const WORKBENCH_STATUS_SUCCESS_CLASS =
    "rounded-full border border-[#16845B]/20 bg-[#E4F8EE] px-2 py-0.5 text-[#16845B]";
  export const WORKBENCH_STATUS_WARNING_CLASS =
    "rounded-full border border-[#FAD355]/45 bg-[#FFF8DB] px-2 py-0.5 text-[#8B5E00]";
  export const WORKBENCH_STATUS_DANGER_CLASS =
    "rounded-full border border-[#FAD4D4] bg-[#FFF1F0] px-2 py-0.5 text-[#B42318]";
  export const WORKBENCH_STATUS_NEUTRAL_CLASS =
    "rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-2 py-0.5 text-[#646A73]";
  ```

  Temporarily alias legacy constants so existing imports still compile:

  ```ts
  export const COMPACT_IOS_PAGE_BACKGROUND = WORKBENCH_PAGE_BACKGROUND_CLASS;
  export const GLASS_PANEL_CLASS = WORKBENCH_SECTION_CLASS;
  export const GLASS_TOP_BAR_CLASS = WORKBENCH_TOP_BAR_CLASS;
  export const DENSE_GLASS_ICON_BUTTON_CLASS = WORKBENCH_ICON_BUTTON_CLASS;
  export const MOBILE_GLASS_ICON_BUTTON_CLASS = WORKBENCH_MOBILE_ICON_BUTTON_CLASS;
  ```

- [ ] **Step 4: Run primitive tests**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/stylePrimitives.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit primitive batch**

  ```bash
  git add app/src/components/workbench/stylePrimitives.ts app/src/components/workbench/stylePrimitives.test.ts
  git commit -m "style(workbench): add feishu design primitives"
  ```

## Task 2: Shell And Primary Navigation

**Files:**
- Modify: `app/src/components/workbench/WorkbenchShell.tsx`
- Modify: `app/src/components/workbench/WorkbenchShell.test.tsx`
- Modify: `app/src/components/workbench/ProductTopBar.tsx`
- Modify: `app/src/components/workbench/ProductTopBar.test.tsx`
- Modify: `app/src/components/workbench/MobileTabBar.tsx`
- Modify: `app/src/components/workbench/MobileTabBar.test.tsx`

- [ ] **Step 1: Update tests for Feishu-style top and mobile navigation**

  In `ProductTopBar.test.tsx`, replace `testSelectedTopTabHasStrongerTreatment` with:

  ```ts
  function testSelectedTopTabUsesFeishuWorkbenchTreatment() {
    const html = renderProductTopBar();
    const selectedTab = html.match(/<button[^>]*data-ripple-top-tab="sessions"[^>]*>/)?.[0] || "";

    assert.match(selectedTab, /bg-\[#F0F5FF\]/);
    assert.match(selectedTab, /text-\[#1456F0\]/);
    assert.match(selectedTab, /border-\[#BACEFD\]/);
    assert.doesNotMatch(selectedTab, /text-white/);
    assert.doesNotMatch(selectedTab, /shadow-\[0_8px_18px_rgba\(20,86,240,0\.22\)\]/);
  }
  ```

  Add a source assertion that `ProductTopBar.tsx` imports `WORKBENCH_TOP_BAR_CLASS`.

  In `MobileTabBar.test.tsx`, update selected treatment assertions to expect:

  ```ts
  assert.match(html, /rounded-2xl/);
  assert.match(html, /shadow-\[0_8px_24px_rgba\(31,35,41,0\.10\)\]/);
  assert.doesNotMatch(html, /shadow-\[0_18px_44px_rgba\(31,35,41,0\.20\)\]/);
  assert.doesNotMatch(html, /rounded-\[28px\]/);
  ```

  In `WorkbenchShell.test.tsx`, update the collapsed inspector assertion from `bg-white/82` to `WORKBENCH_ICON_BUTTON_CLASS`-compatible output:

  ```ts
  assert.match(html, /rounded-l-xl/);
  assert.match(html, /bg-white/);
  assert.doesNotMatch(html, /backdrop-blur-xl/);
  ```

- [ ] **Step 2: Run shell/navigation tests and verify they fail**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/ProductTopBar.test.tsx src/components/workbench/MobileTabBar.test.tsx src/components/workbench/WorkbenchShell.test.tsx
  ```

  Expected: FAIL because implementation still uses glass classes, strong blue tabs, and heavier mobile shadow.

- [ ] **Step 3: Update shell and navigation implementation**

  - In `WorkbenchShell.tsx`, import `WORKBENCH_PAGE_BACKGROUND_CLASS` and `WORKBENCH_ICON_BUTTON_CLASS`.
  - Replace shell background usage with `WORKBENCH_PAGE_BACKGROUND_CLASS`.
  - Replace collapsed inspector handle button classes with a composed class based on `WORKBENCH_ICON_BUTTON_CLASS`, preserving `absolute top-1/2 right-0 z-30 hidden h-14 w-7 -translate-y-1/2 rounded-l-xl border-r-0 xl:inline-flex`.
  - In `ProductTopBar.tsx`, import `WORKBENCH_TOP_BAR_CLASS`.
  - Set the header class to `flex h-[52px] w-full items-center px-4 ${WORKBENCH_TOP_BAR_CLASS}`.
  - Change the top-tab container to a flatter segmented row: `inline-flex items-center gap-0.5 rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] p-0.5`.
  - Change selected tab class to `border border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0] shadow-none`.
  - Change unselected tab class to `border border-transparent text-[#2B2F36] hover:bg-white hover:text-[#1F2329]`.
  - Add a 2px bottom indicator span inside selected tab or use `after:` classes if the rendered output remains testable.
  - In `MobileTabBar.tsx`, import `WORKBENCH_PAGE_BACKGROUND_CLASS`.
  - Replace `rounded-[28px]` with `rounded-2xl`.
  - Reduce mobile nav shadow to `shadow-[0_8px_24px_rgba(31,35,41,0.10)]`.
  - Keep safe-area mask, fixed position, tab labels, and `IconTile` usage unchanged.

- [ ] **Step 4: Run shell/navigation tests**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/ProductTopBar.test.tsx src/components/workbench/MobileTabBar.test.tsx src/components/workbench/WorkbenchShell.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 5: Commit shell/navigation batch**

  ```bash
  git add app/src/components/workbench/WorkbenchShell.tsx app/src/components/workbench/WorkbenchShell.test.tsx app/src/components/workbench/ProductTopBar.tsx app/src/components/workbench/ProductTopBar.test.tsx app/src/components/workbench/MobileTabBar.tsx app/src/components/workbench/MobileTabBar.test.tsx
  git commit -m "style(workbench): calm shell navigation chrome"
  ```

## Task 3: Session Rail, Chat Chrome, And Markdown Notices

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.tsx`
- Modify: `app/src/components/workbench/WorkspaceNav.test.tsx`
- Modify: `app/src/components/workbench/SessionPage.tsx`
- Modify: `app/src/components/workbench/SessionComposer.tsx`
- Modify: `app/src/components/workbench/SessionTimeline.tsx`
- Modify: `app/src/components/workbench/SessionPage.test.tsx`
- Modify: `app/src/components/workbench/SessionComposer.test.tsx`
- Modify: `app/src/components/workbench/SessionTimeline.test.tsx`
- Modify: `app/src/components/MarkdownRenderer.tsx`
- Modify: `app/src/components/MarkdownRenderer.test.tsx`

- [ ] **Step 1: Update tests for session and notice style expectations**

  In `WorkspaceNav.test.tsx`, add assertions:

  ```ts
  assert.match(html, /data-ripple-session-rail="true"/);
  assert.match(html, /bg-white/);
  assert.doesNotMatch(html, /backdrop-blur-2xl/);
  assert.doesNotMatch(html, /shadow-\[8px_0_22px/);
  ```

  Update selected-session expectation to include `bg-[#F0F5FF]` and no `shadow-[0_6px_16px`.

  In `MarkdownRenderer.test.tsx`, add or update connector card tests to assert connector auth cards:

  ```ts
  assert.match(html, /border-\[#DEE0E3\]/);
  assert.match(html, /bg-white/);
  assert.doesNotMatch(html, /backdrop-blur-xl/);
  assert.doesNotMatch(html, /bg-white\/74/);
  ```

  In session tests, update toolbar/icon assertions to expect `WORKBENCH_MOBILE_ICON_BUTTON_CLASS` output: `rounded-xl`, solid white, gray border, and no `backdrop-blur-xl`.

- [ ] **Step 2: Run session-related tests and verify they fail**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/WorkspaceNav.test.tsx src/components/workbench/SessionPage.test.tsx src/components/workbench/SessionComposer.test.tsx src/components/workbench/SessionTimeline.test.tsx src/components/MarkdownRenderer.test.tsx
  ```

  Expected: FAIL because old session chrome and Markdown connector cards still use glass-heavy classes.

- [ ] **Step 3: Implement session and Markdown style convergence**

  - In `WorkspaceNav.tsx`, import shared primitives from `stylePrimitives.ts`.
  - Change the rail container to `border-r border-[#DEE0E3] bg-white text-[#1F2329]`.
  - Use `WORKBENCH_ICON_BUTTON_CLASS` for collapse and options buttons where possible.
  - Change selected session rows to `border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0] shadow-none`.
  - Change new session button to `h-8 w-full ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}` with no large shadow.
  - Change session menu container to `WORKBENCH_MENU_CLASS`.
  - Change normal menu items to `WORKBENCH_MENU_ITEM_CLASS` and destructive item to `WORKBENCH_MENU_DANGER_ITEM_CLASS`.
  - In `SessionPage.tsx`, replace `MOBILE_GLASS_ICON_BUTTON_CLASS` import usage with `WORKBENCH_MOBILE_ICON_BUTTON_CLASS` or alias output.
  - Normalize warning banners, token badges, and header buttons to solid white or semantic backgrounds without blur.
  - In `SessionComposer.tsx`, keep behavior and layout but reduce composer container shadow/radius to shared surface tokens.
  - In `SessionTimeline.tsx`, keep message layout but normalize notice/status cards to shared section/status primitives.
  - In `MarkdownRenderer.tsx`, replace connector auth card wrappers with `rounded-xl border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]`.

- [ ] **Step 4: Run session-related tests**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/WorkspaceNav.test.tsx src/components/workbench/SessionPage.test.tsx src/components/workbench/SessionComposer.test.tsx src/components/workbench/SessionTimeline.test.tsx src/components/MarkdownRenderer.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 5: Commit session batch**

  ```bash
  git add app/src/components/workbench/WorkspaceNav.tsx app/src/components/workbench/WorkspaceNav.test.tsx app/src/components/workbench/SessionPage.tsx app/src/components/workbench/SessionComposer.tsx app/src/components/workbench/SessionTimeline.tsx app/src/components/workbench/SessionPage.test.tsx app/src/components/workbench/SessionComposer.test.tsx app/src/components/workbench/SessionTimeline.test.tsx app/src/components/MarkdownRenderer.tsx app/src/components/MarkdownRenderer.test.tsx
  git commit -m "style(session): align chat chrome with feishu"
  ```

## Task 4: Workspace Files And Preview Chrome

**Files:**
- Modify: `app/src/components/WorkspaceExplorer.tsx`
- Modify: `app/src/components/WorkspaceExplorer.test.tsx`
- Modify: `app/src/components/workspace/WorkspaceToolbar.tsx`
- Modify: `app/src/components/workspace/WorkspaceFileList.tsx`
- Modify: `app/src/components/workspace/WorkspaceActionMenus.tsx`
- Modify: `app/src/components/workspace/WorkspaceConfirmDialog.tsx`
- Modify: `app/src/components/workspace/WorkspaceCreateEntryDialog.tsx`
- Modify: `app/src/components/workspace/WorkspacePreviewPanel.tsx`
- Modify relevant workspace tests under `app/src/components/workspace/`

- [ ] **Step 1: Update workspace tests for solid workbench chrome**

  Update tests to expect:

  ```ts
  assert.doesNotMatch(source, /backdrop-blur-xl/);
  assert.doesNotMatch(source, /rounded-\[28px\]/);
  assert.match(source, /WORKBENCH_MENU_CLASS|WORKBENCH_SECTION_CLASS|WORKBENCH_SECONDARY_BUTTON_CLASS/);
  ```

  Keep tests that protect file operations, preview behavior, selection behavior, and mobile action sheets unchanged.

- [ ] **Step 2: Run workspace tests and verify style failures**

  Run:

  ```bash
  cd app
  bun test src/components/WorkspaceExplorer.test.tsx src/components/workspace/WorkspaceActionMenus.test.tsx src/components/workspace/WorkspaceCreateEntryDialog.test.tsx src/components/workspace/WorkspaceFileList.test.tsx src/components/workspace/WorkspacePreviewPanel.test.tsx
  ```

  Expected: FAIL only for style assertions added or updated in this task.

- [ ] **Step 3: Implement workspace visual convergence**

  - Replace page/compact frame classes with `WORKBENCH_SECTION_CLASS` or solid white keyline equivalents.
  - Replace toolbar icon/action buttons with shared icon/secondary/primary button primitives.
  - Replace context menus with `WORKBENCH_MENU_CLASS`, `WORKBENCH_MENU_ITEM_CLASS`, and `WORKBENCH_MENU_DANGER_ITEM_CLASS`.
  - Keep document and code preview surfaces mostly flat for readability.
  - Keep mobile selection bar and fullscreen preview behavior unchanged while reducing shadow and blur.
  - Keep all file operation handlers, rename behavior, upload behavior, and preview request logic unchanged.

- [ ] **Step 4: Run workspace tests**

  Run:

  ```bash
  cd app
  bun test src/components/WorkspaceExplorer.test.tsx src/components/workspace/WorkspaceActionMenus.test.tsx src/components/workspace/WorkspaceCreateEntryDialog.test.tsx src/components/workspace/WorkspaceFileList.test.tsx src/components/workspace/WorkspacePreviewPanel.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 5: Commit workspace batch**

  ```bash
  git add app/src/components/WorkspaceExplorer.tsx app/src/components/WorkspaceExplorer.test.tsx app/src/components/workspace/WorkspaceToolbar.tsx app/src/components/workspace/WorkspaceFileList.tsx app/src/components/workspace/WorkspaceActionMenus.tsx app/src/components/workspace/WorkspaceConfirmDialog.tsx app/src/components/workspace/WorkspaceCreateEntryDialog.tsx app/src/components/workspace/WorkspacePreviewPanel.tsx app/src/components/workspace/*.test.tsx
  git commit -m "style(workspace): unify file chrome surfaces"
  ```

## Task 5: Secondary Workbench Pages

**Files:**
- Modify: `app/src/components/workbench/SkillsPage.tsx`
- Modify: `app/src/components/workbench/SkillsPage.test.tsx`
- Modify: `app/src/components/workbench/ConnectorsPage.tsx`
- Modify: `app/src/components/workbench/ConnectorsPage.test.tsx`
- Modify: `app/src/components/workbench/AutomationsPage.tsx`
- Modify: `app/src/components/workbench/AutomationsPage.test.tsx`
- Modify: `app/src/components/workbench/SettingsPage.tsx`
- Modify: `app/src/components/workbench/SettingsPage.test.tsx`
- Review and modify only if touched by shared primitive migration: `app/src/components/AuthGateway.tsx`
- Review and modify only if `AuthGateway.tsx` changes: `app/src/components/AuthGateway.test.tsx`

- [ ] **Step 1: Update secondary page tests**

  Add source assertions that these pages import at least one shared workbench primitive:

  ```ts
  assert.match(source, /WORKBENCH_(SECTION|SURFACE|PRIMARY_BUTTON|SECONDARY_BUTTON|STATUS|FIELD|MENU)/);
  ```

  Add assertions that major page sections avoid primary-surface blur:

  ```ts
  assert.doesNotMatch(source, /bg-white\/7[02468].*backdrop-blur-xl/);
  assert.doesNotMatch(source, /shadow-\[0_18px_44px/);
  ```

  Preserve existing behavior tests for skills category navigation, connector auth status, automation CRUD, settings model/profile/account behavior, and mobile sheets.

- [ ] **Step 2: Run secondary page tests and verify they fail**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/SkillsPage.test.tsx src/components/workbench/ConnectorsPage.test.tsx src/components/workbench/AutomationsPage.test.tsx src/components/workbench/SettingsPage.test.tsx src/components/AuthGateway.test.tsx
  ```

  Expected: FAIL for pages not yet using shared primitives or still using old glass-heavy section classes.

- [ ] **Step 3: Implement secondary page convergence**

  - Replace page backgrounds with `WORKBENCH_PAGE_BACKGROUND_CLASS`.
  - Replace section wrappers with `WORKBENCH_SECTION_CLASS`.
  - Replace form fields with `WORKBENCH_FIELD_CLASS` plus page-specific size padding.
  - Replace primary actions with `WORKBENCH_PRIMARY_BUTTON_CLASS` and fixed heights from the spec.
  - Replace secondary/danger action buttons with `WORKBENCH_SECONDARY_BUTTON_CLASS` and `WORKBENCH_DANGER_BUTTON_CLASS`.
  - Replace status pills with the shared status primitives.
  - Replace dropdown/popover/action menus with `WORKBENCH_MENU_CLASS` and menu item primitives.
  - Keep mobile sheets functional and safe-area aware; reduce only excessive blur/shadow.
  - Touch `AuthGateway.tsx` only if the same button/input primitives can be adopted without layout churn.

- [ ] **Step 4: Run secondary page tests**

  Run:

  ```bash
  cd app
  bun test src/components/workbench/SkillsPage.test.tsx src/components/workbench/ConnectorsPage.test.tsx src/components/workbench/AutomationsPage.test.tsx src/components/workbench/SettingsPage.test.tsx src/components/AuthGateway.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 5: Commit secondary page batch**

  ```bash
  git add app/src/components/workbench/SkillsPage.tsx app/src/components/workbench/SkillsPage.test.tsx app/src/components/workbench/ConnectorsPage.tsx app/src/components/workbench/ConnectorsPage.test.tsx app/src/components/workbench/AutomationsPage.tsx app/src/components/workbench/AutomationsPage.test.tsx app/src/components/workbench/SettingsPage.tsx app/src/components/workbench/SettingsPage.test.tsx app/src/components/AuthGateway.tsx app/src/components/AuthGateway.test.tsx
  git commit -m "style(pages): align secondary workbench surfaces"
  ```

## Task 6: Final Verification And Visual Audit

**Files:**
- Inspect all touched app files.
- Update `docs/superpowers/specs/2026-06-08-feishu-design-language-unification-design.md` only if implementation reveals a necessary clarification to an already approved requirement.

- [ ] **Step 1: Run full frontend tests**

  Run:

  ```bash
  cd app
  bun test
  ```

  Expected: PASS.

- [ ] **Step 2: Run lint**

  Run:

  ```bash
  cd app
  bun run lint
  ```

  Expected: PASS or only pre-existing lint warnings unrelated to touched files. If lint fails in touched files, fix before continuing.

- [ ] **Step 3: Run build**

  Run:

  ```bash
  cd app
  bun run build
  ```

  Expected: PASS.

- [ ] **Step 4: Search for disallowed main-surface patterns**

  Run:

  ```bash
  rg -n "COMPACT_IOS|GLASS_|rounded-\\[28px\\]|shadow-\\[0_18px_44px|bg-white/7[02468].*backdrop-blur|backdrop-blur-xl" app/src/components app/src/App.tsx app/src/globals.css
  ```

  Expected: Any remaining matches are legacy aliases, mobile sheets, popovers, modals, dropdowns, or explicitly reviewed floating layers. Main shell/page/section surfaces should not use the old glass vocabulary.

- [ ] **Step 5: Run a local dev server for visual inspection**

  Run:

  ```bash
  cd app
  bun run dev
  ```

  Expected: Vite serves the app on `http://localhost:8820/` or another available port.

- [ ] **Step 6: Capture or manually inspect desktop and mobile viewports**

  Inspect at least:

  - Desktop wide: shell, top bar, session rail, chat, inspector.
  - Desktop narrow/tablet: top tabs and page sections.
  - Mobile: bottom tabs, sessions list, chat detail, files page, settings page, connector auth/status.

  Expected:

  - App structure is unchanged.
  - Ripple logo is unchanged.
  - Main app reads as a restrained collaborative workbench.
  - Floating layers still have enough elevation.
  - Text fits buttons, tabs, cards, and mobile controls.
  - Mobile safe-area spacing remains correct.

- [ ] **Step 7: Commit final verification cleanup if needed**

  If verification required any final fixes:

  ```bash
  git add <fixed-files>
  git commit -m "style(workbench): finish feishu visual audit"
  ```

  If no files changed after verification, do not create an empty commit.
