# Workspace Session Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an elegant dropdown actions menu (More Actions) for workspace session list items in `WorkspaceNav`, supporting Pinned toggle, Inline renaming, and Delete actions with keyboard and click-outside control.

**Architecture:** 
- Propagate session update capabilities to `WorkspaceNav` using an `onUpdateSession` prop.
- Introduce relative row layouts, lightweight overlay-based click-outside mechanism, dynamic button visibility, and inline text `<input />` editor with Escape/Enter/Blur lifecycle hooks.
- Write direct tests in `WorkspaceNav.test.tsx` to assert pin indicators, menu visibility, and inline editor rendering under correct mock callbacks.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Bun, Node standard assert.

---

### Task 1: Update API Interfaces and Hook/App integration

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.tsx`
- Modify: `app/src/App.tsx`

- [ ] **Step 1: Update WorkspaceNavProps interface**

Modify `WorkspaceNavProps` in `app/src/components/workbench/WorkspaceNav.tsx` to include `onUpdateSession` prop.

```typescript
// app/src/components/workbench/WorkspaceNav.tsx
interface WorkspaceNavProps {
  sessions: WorkbenchSessionSummary[];
  selectedSessionId: string | null;
  activeView: WorkspaceView;
  isLoading: boolean;
  sessionLoadError?: string | null;
  isGenerating: boolean;
  userId: string;
  onNewSession: () => void;
  onSelectView: (view: WorkspaceView) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
  onUpdateSession: (
    sessionId: string,
    updates: { title?: string; pinned?: boolean }
  ) => Promise<any>;
  onOpenSettings: () => void;
}
```

- [ ] **Step 2: Connect updateSessionById from App.tsx**

Update `app/src/App.tsx` where `<WorkspaceNav />` is rendered (both in mobile view if applicable, and main app desktop sidebar) to pass down `onUpdateSession`. Since `App.tsx` receives `updateSessionById` from `useSessionLifecycle`, we can pass it down as:

```typescript
// app/src/App.tsx
            onDeleteSession={handleDeleteSession}
            onUpdateSession={updateSessionById}
            onOpenSettings={() => setIsSettingsOpen(true)}
```

Let's double-check if there are multiple occurrences of `<WorkspaceNav` in `App.tsx`.
Yes, there are multiple matches in `App.tsx`:
- Line 437: mobile view block if any.
- Line 455: another layout if any.
- Line 582: main App.
Let's pass `onUpdateSession={updateSessionById}` to ALL of them.

---

### Task 2: Implement Dropdown Menu and Inline Renaming in WorkspaceNav

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.tsx`

- [ ] **Step 1: Add Lucide imports**

Ensure `Edit3` and `MoreHorizontal` are imported from `lucide-react`.

```typescript
import { AlertTriangle, Edit3, Loader2, MoreHorizontal, Pin, Plus, Settings, Trash2 } from "lucide-react";
```

- [ ] **Step 2: Add local dropdown & rename states**

Add React state variables at the beginning of `WorkspaceNav`:

```typescript
  const [activeMenuSessionId, setActiveMenuSessionId] = React.useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = React.useState<string | null>(null);
  const [editingTitle, setEditingTitle] = React.useState<string>("");
```

- [ ] **Step 3: Add Click-Outside Backdrop**

Render a viewport-covering overlay under the list when any menu is open:

```typescript
  return (
    <div className="flex h-full min-h-0 flex-col text-[#0d0d0d]" aria-busy={isGenerating}>
      {activeMenuSessionId && (
        <div
          className="fixed inset-0 z-40 bg-transparent"
          onClick={() => setActiveMenuSessionId(null)}
        />
      )}
```

- [ ] **Step 4: Refactor Session Mapping UI**

Replace the current session item list block with:
1. An inline-editing block when `editingSessionId === session.sessionId`.
2. A list item with a `group relative` wrapping `div`, replacing the direct hover Trash button with a dynamic `MoreHorizontal` options button and absolute Dropdown menu container.

**Code implementation:**

```typescript
            <div className="space-y-1">
              {sessions.map((session) => {
                const selected = session.sessionId === selectedSessionId;
                const activityTime = formatSessionActivityTime(session.lastActivityAt);
                const isEditing = editingSessionId === session.sessionId;

                if (isEditing) {
                  const handleSave = () => {
                    const trimmed = editingTitle.trim();
                    if (trimmed && trimmed !== session.title) {
                      void onUpdateSession(session.sessionId, { title: trimmed });
                    }
                    setEditingSessionId(null);
                  };

                  return (
                    <div
                      key={session.sessionId}
                      className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[#0d0d0d] bg-white border border-[#2463eb]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SessionAttentionDot attention={session.attention} reserveSpace />
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={handleSave}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleSave();
                          } else if (e.key === "Escape") {
                            setEditingSessionId(null);
                          }
                        }}
                        className="min-w-0 flex-1 bg-transparent py-0.5 text-sm font-medium text-[#0d0d0d] outline-none"
                        autoFocus
                        maxLength={120}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={session.sessionId}
                    className={`group relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                      selected
                        ? "bg-[#eef4ff] text-[#0b57d0]"
                        : "text-[#374151] hover:bg-white hover:text-[#0d0d0d]"
                    }`}
                  >
                    <SessionAttentionDot attention={session.attention} reserveSpace />
                    <button
                      type="button"
                      onClick={() => onSelectSession(session.sessionId)}
                      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-0.5 text-left text-sm font-medium"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        {session.pinned ? (
                          <Pin size={11} className="shrink-0 text-[#8b8f94]" />
                        ) : null}
                        <span className="truncate">{session.title}</span>
                      </span>
                      {activityTime && (
                        <span
                          className={`font-[family-name:var(--font-mono)] text-[11px] font-normal ${
                            selected ? "text-[#4d6fb8]" : "text-[#8b8f94]"
                          }`}
                        >
                          {activityTime}
                        </span>
                      )}
                    </button>
                    
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuSessionId(
                          activeMenuSessionId === session.sessionId ? null : session.sessionId
                        );
                      }}
                      className={`h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors ${
                        activeMenuSessionId === session.sessionId
                          ? "flex border-[#e5e7eb] bg-white text-[#0d0d0d] z-50"
                          : "hidden border-transparent text-[#8b8f94] group-hover:flex hover:border-[#e5e7eb] hover:bg-white hover:text-[#0d0d0d]"
                      }`}
                      title="Session options"
                    >
                      <MoreHorizontal size={13} />
                    </button>

                    {activeMenuSessionId === session.sessionId && (
                      <div className="absolute right-2 top-9 z-50 w-36 rounded-lg border border-[#e5e7eb] bg-white py-1 shadow-[0_4px_12px_rgba(0,0,0,0.08)]">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onUpdateSession(session.sessionId, { pinned: !session.pinned });
                            setActiveMenuSessionId(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[#374151] hover:bg-[#f3f4f6] hover:text-[#0d0d0d]"
                        >
                          <Pin size={12} className="shrink-0 text-[#6b7280]" />
                          {session.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingSessionId(session.sessionId);
                            setEditingTitle(session.title);
                            setActiveMenuSessionId(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[#374151] hover:bg-[#f3f4f6] hover:text-[#0d0d0d]"
                        >
                          <Edit3 size={12} className="shrink-0 text-[#6b7280]" />
                          Rename
                        </button>
                        <div className="my-1 border-t border-[#e5e7eb]" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession(session.sessionId, e);
                            setActiveMenuSessionId(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[#cf222e] hover:bg-[#ffebe9]"
                        >
                          <Trash2 size={12} className="shrink-0 text-[#cf222e]" />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
```

---

### Task 3: Add Tests and Linting

**Files:**
- Modify: `app/src/components/workbench/WorkspaceNav.test.tsx`

- [ ] **Step 1: Add new assertions to tests**

Add `onUpdateSession` to the default props inside `renderWorkspaceNav`:

```typescript
function renderWorkspaceNav(overrides: Partial<React.ComponentProps<typeof WorkspaceNav>> = {}) {
  const props = {
    // ... other props ...
    onDeleteSession: noop,
    onUpdateSession: async () => {},
    onOpenSettings: noop,
    ...overrides,
  } as React.ComponentProps<typeof WorkspaceNav> & { sessionLoadError?: string | null };

  return renderToStaticMarkup(<WorkspaceNav {...props} />);
}
```

Add a new unit test at the bottom of the file to verify `Pin` indicator rendering:

```typescript
function testRendersPinnedSessionWithIcon() {
  const html = renderWorkspaceNav({
    sessions: [
      {
        sessionId: "pinned-1",
        title: "Pinned Session",
        pinned: true,
        status: "idle",
        model: "codex-medium",
        lastActivityAt: "2026-05-17T00:00:00Z",
        messageCount: 0,
        changedFileCount: 0,
        pendingApprovalCount: 0,
      },
    ],
  });

  assert.match(html, /Pinned Session/);
  // Matches lucide-pin icon (uses lucide-pin class or SVG markup)
  assert.match(html, /lucide-pin/);
}

testRendersPinnedSessionWithIcon();
```

- [ ] **Step 2: Run Tests**

Run the test suite using:
```bash
bun run app/src/components/workbench/WorkspaceNav.test.tsx
```
Expected output: `workspace nav tests passed`

- [ ] **Step 3: Run Linter and Formatter**

Run ruff / bun lint commands if applicable. In frontend:
```bash
cd app && bun run lint && bun run build
```
Verify no TypeScript errors or linter compilation failures.
