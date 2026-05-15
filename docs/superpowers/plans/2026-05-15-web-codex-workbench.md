# Web Codex Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production web home with a Codex Workbench that maps the current server session/runtime model into task-first navigation, timeline, composer, and inspector surfaces.

**Architecture:** Keep the existing server APIs for this pass. Add small typed client adapters that convert sessions, messages, tool calls, sandbox, connectors, and workspace data into Workbench props. Split the page into focused React components under `src/components/workbench/`, then make `src/app/page.tsx` the stateful orchestration layer.

**Tech Stack:** TypeScript, React 19, Next.js App Router, Tailwind CSS v4, lucide-react, existing Ripple API helpers.

---

### Task 1: Workbench Data Adapter

**Files:**
- Create: `src/interfaces/web/src/lib/workbench.ts`
- Create: `src/interfaces/web/src/lib/workbench.test.ts`
- Modify: `src/interfaces/web/src/types/index.ts`

- [ ] Write a failing TypeScript test that maps `Session[]` to task summaries and prioritizes sessions awaiting permission.
- [ ] Implement focused Workbench types and pure mapping helpers.
- [ ] Run the new test with `bun src/lib/workbench.test.ts`.

### Task 2: Workbench Components

**Files:**
- Create: `src/interfaces/web/src/components/workbench/WorkbenchShell.tsx`
- Create: `src/interfaces/web/src/components/workbench/WorkbenchTopBar.tsx`
- Create: `src/interfaces/web/src/components/workbench/WorkspaceNav.tsx`
- Create: `src/interfaces/web/src/components/workbench/TaskPage.tsx`
- Create: `src/interfaces/web/src/components/workbench/TaskTimeline.tsx`
- Create: `src/interfaces/web/src/components/workbench/TaskComposer.tsx`
- Create: `src/interfaces/web/src/components/workbench/InspectorPanel.tsx`

- [ ] Build presentational components with typed props.
- [ ] Use the accepted Codex Workbench visual tokens: white page, `#f6f8fa` panels, `#d0d7de` borders, compact 6-8px controls, lucide icons.
- [ ] Keep mobile behavior usable with nav/inspector collapsing into stacked sections.

### Task 3: Production Page Wiring

**Files:**
- Modify: `src/interfaces/web/src/app/page.tsx`
- Modify as needed: existing chat/workspace/settings components when reused in the Workbench shell.

- [ ] Replace the chat-first production shell with `WorkbenchShell`.
- [ ] Preserve existing authentication, API key, user id, model selection, session restore, send/stop, permission resolve, workspace refresh, settings, and connectors behavior.
- [ ] Map message history into task timeline events and tool calls into terminal inspector content.
- [ ] Surface pending approvals in the task header and Approvals inspector.

### Task 4: Verification

**Files:**
- Use changed files from Tasks 1-3.

- [ ] Run `bun src/lib/workbench.test.ts`.
- [ ] Run existing focused tests: `bun src/lib/chatState.test.ts`, `bun src/lib/sessionPersistence.test.ts`, `bun src/lib/inputFocus.test.ts`, `bun src/lib/terminalOutput.test.ts`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run build`.
