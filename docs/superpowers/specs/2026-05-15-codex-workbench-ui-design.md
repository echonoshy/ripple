# Codex Workbench UI Design

Date: 2026-05-15
Status: Design accepted as preferred UI direction
Reference mock: `src/interfaces/web/src/app/mock-ui/page.tsx` route `/mock-ui`, variant `Codex Workbench`

## Purpose

Ripple should move from a chat-first interface to an agent workbench interface. The UI should make the user feel they are supervising real work: tasks, plans, files, commands, approvals, and reviewable output are first-class objects. Chat remains available, but it becomes a command and steering surface inside the task page rather than the whole product.

The chosen direction is **Codex Workbench**:

- Notion-like workspace navigation for persistent project context.
- GitHub-like density, borders, lists, status chips, checks, files, and review metadata.
- Codex-like task supervision with a central task page and right-side inspector for files, terminal, diff, context, and approvals.

## Product Principles

1. **Task over chat**
   The primary object is an agent task or work session. Messages are part of the task timeline, not the only UI surface.

2. **Inspectable work**
   Every meaningful agent action should be visible as timeline events, tool calls, file changes, checks, approvals, or terminal output.

3. **Quiet, dense, reliable**
   The visual style should feel like GitHub plus Notion: restrained colors, 1px borders, low shadow usage, readable density, and clear status hierarchy.

4. **Review before trust**
   User approvals, risky commands, diffs, and changed files should be easy to find without scrolling through chat.

5. **API-ready but mockable**
   The UI should be implementable against fake data first, then wired to server APIs when product semantics are settled.

## Top-Level Layout

Desktop layout uses three persistent regions:

```text
┌─────────────────────────────────────────────────────────────┐
│ Top bar: repo / user / sandbox / model / status / actions   │
├───────────────┬─────────────────────────────┬───────────────┤
│ Workspace nav │ Task detail / working thread │ Inspector     │
│ Task queues   │ Overview / Timeline / Changes│ Files         │
│ Projects      │ Composer at bottom           │ Terminal      │
│ Automations   │                              │ Diff          │
└───────────────┴─────────────────────────────┴───────────────┘
```

Mobile and narrow tablet layout should collapse this into:

- Top bar stays visible.
- Left workspace navigation becomes a drawer.
- Right inspector becomes a bottom sheet or tabbed panel.
- The central task page remains the primary view.

## Region Responsibilities

### Top Bar

The top bar identifies where work is happening.

Required content:

- Product mark and current task or project title.
- Repository/workspace label, for example `echonoshy/ripple`.
- Current user/sandbox identity, for example `lake/default`.
- Model selector or model badge.
- Online/running/paused/error status.
- Notifications and settings entry points.

Top bar should not become a large command center. Keep it compact and stable.

### Workspace Navigation

The left rail organizes persistent work.

Primary sections:

- Search
- Active tasks
- Review queue
- Workspaces
- Automations
- Projects
- Recent tasks

Task list items should show:

- Task title
- Status dot or chip
- Short metadata, such as changed files, pending approvals, or queue position
- Selection state

This area replaces the old pure session list. Sessions can still exist internally, but the user-facing label should become task/workspace oriented.

### Main Task Page

The central pane is the main work surface.

Header content:

- Task title
- Status chips, for example `Running`, `Review`, `Queued`, `Blocked`
- Branch/worktree label
- Sandbox readiness
- Optional context usage warning

Tabs:

- **Overview**: goal, current plan, recent progress, next expected action.
- **Timeline**: user prompts, assistant updates, tool calls, command summaries, file changes, approvals.
- **Changes**: changed files, commit-like summaries, and diff entry points.
- **Notes**: user/project notes that should persist with the task.

Bottom composer:

- Lets user ask, redirect, approve, deny, or add context.
- Should support normal text first; file/context attachments can be added later.
- Stop/run controls should be available near the composer when a task is active.

### Right Inspector

The inspector is the "proof of work" surface.

Primary tabs:

- **Files**: workspace browser and changed files.
- **Terminal**: command output and live tool execution logs.
- **Diff**: reviewable file changes.
- **Context**: loaded instructions, skills, selected files, model, sandbox, connector state.
- **Approvals**: pending permission requests and risk details.

The inspector should be resizable on desktop and collapsible. When hidden, important pending approvals must still surface in the top bar or task header.

## Visual System

The visual direction should replace the current playful/brutalist UI tokens for the workbench surface.

Core tokens:

```text
Page background:       #ffffff
Subtle background:     #f6f8fa
Border:                #d0d7de
Text primary:          #24292f
Text secondary:        #57606a
Text muted:            #6e7781
Accent blue:           #0969da
Success green:         #1a7f37
Warning yellow:        #bf8700
Danger red:            #cf222e
Code background:       #0d1117
Code text:             #c9d1d9
Radius:                6px to 8px
Border width:          1px
Shadow:                minimal; prefer borders and background layers
```

Typography:

- Use the existing app font stack unless a broader typography decision is made later.
- Use normal letter spacing.
- Use mono only for IDs, paths, commands, model names, and logs.
- Avoid hero-scale type inside the product shell.

Interaction style:

- Hover states should be subtle background changes.
- Selected states should use a filled neutral surface or blue border.
- Status should use chips and small dots, not oversized banners.
- Icons should use `lucide-react`, matching the existing frontend dependency.

## Component Inventory

Future implementation should split the mock into focused components:

- `WorkbenchShell`
- `WorkbenchTopBar`
- `WorkspaceNav`
- `TaskQueueList`
- `TaskQueueItem`
- `TaskPage`
- `TaskHeader`
- `TaskTabs`
- `TaskOverview`
- `TaskTimeline`
- `TimelineEvent`
- `TaskComposer`
- `InspectorPanel`
- `InspectorTabs`
- `FilesInspector`
- `TerminalInspector`
- `DiffInspector`
- `ContextInspector`
- `ApprovalsInspector`
- `StatusChip`
- `IconButton`

These components should start with typed mock data props. API wiring should be added after server endpoints are finalized.

## Data Model Draft

The exact server API is intentionally not fixed yet. The UI should be prepared for these conceptual objects.

```ts
type WorkbenchTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";

interface WorkbenchTaskSummary {
  id: string;
  title: string;
  status: WorkbenchTaskStatus;
  project?: string;
  branch?: string;
  lastActivityAt: string;
  changedFileCount: number;
  pendingApprovalCount: number;
}

interface WorkbenchTaskDetail extends WorkbenchTaskSummary {
  goal: string;
  plan: WorkbenchPlanStep[];
  timeline: WorkbenchTimelineEvent[];
  changedFiles: WorkbenchChangedFile[];
  checks: WorkbenchCheck[];
  context: WorkbenchContextSummary;
  approvals: WorkbenchApprovalRequest[];
}
```

Timeline events should be typed rather than parsed from free-form chat text:

```ts
type WorkbenchTimelineEventType =
  | "user_message"
  | "assistant_message"
  | "plan_update"
  | "tool_call"
  | "command"
  | "file_change"
  | "approval_request"
  | "check_result"
  | "final_summary";
```

## State Rules

Status hierarchy:

- `waiting_for_approval` is the most important state and should override ordinary running indicators.
- `failed` and `blocked` states should be visible in the left nav and task header.
- `review` means agent work is complete enough for user inspection, not necessarily merged or accepted.
- `completed` means no pending approvals, no running commands, and a final summary exists.

Loading rules:

- Left nav can render skeleton task rows.
- Main task page should keep the last known content visible while refreshing.
- Inspector tabs should load independently.
- Terminal output should stream without forcing the main timeline to jump.

Error rules:

- API errors should appear in the region they affect.
- If the selected task cannot load, keep the shell and show an actionable empty/error state in the main pane.
- If approvals fail to submit, keep the approval card visible and show the failed action state.

## Implementation Phases

### Phase 1: Static Workbench Shell

Goal: replace mock-only exploration with real reusable components and typed mock fixtures.

Scope:

- Create component files listed above.
- Move Codex Workbench mock data into fixture objects.
- Keep current production chat route intact.
- Add a feature route or flag for the workbench UI.

### Phase 2: Read-Only API Wiring

Goal: wire navigation, task detail, timeline, files, and terminal history to server APIs.

Scope:

- Fetch task summaries for the left nav.
- Fetch selected task detail.
- Render timeline events from structured server data.
- Render files, checks, context, and terminal history.
- Preserve mock fixtures as fallback story/demo data if useful.

### Phase 3: Interactive Controls

Goal: support real user steering and approvals.

Scope:

- Composer sends task messages or redirects.
- Stop/resume controls call task/session endpoints.
- Approval actions submit allow/always/deny decisions.
- Inspector can refresh files and terminal output.

### Phase 4: Replace Chat-First Home

Goal: promote Workbench UI to the primary web app once feature parity and API semantics are stable.

Scope:

- Migrate existing session selection into task navigation.
- Keep legacy chat route temporarily if needed.
- Update settings, model selection, sandbox identity, and connector UI to fit the workbench shell.

## Open Decisions

These should wait until product behavior and server API semantics are clearer:

- Whether a task maps 1:1 to current session IDs or becomes a new server entity.
- Whether projects are server-backed or derived from workspace/repository metadata.
- Whether file diff data comes from git, Codex-run metadata, or server-side snapshots.
- Whether terminal output should be task-scoped, tool-call-scoped, or session-scoped.
- Whether approvals belong to tasks, sessions, or individual tool calls.
- Whether multiple agents can run inside one task page or require a parent task with child runs.

## Acceptance Criteria For Future Implementation

The implemented workbench should be considered ready when:

- A user can understand current agent work without reading the chat transcript.
- Pending approvals are visible from any workbench state.
- Changed files and terminal output are reachable within one click from the task page.
- The layout remains usable on desktop and collapses cleanly on mobile.
- Visual style reads as a serious tool: restrained color, 1px borders, compact controls, no playful hard-shadow treatment in the workbench surface.
- API wiring is isolated from presentation components through typed props or hooks.

## Current Mock Notes

The current `/mock-ui` route contains three variants. The accepted direction is the `codex` variant:

- Left rail: command center and running tasks.
- Main pane: task header, status chips, tabs, overview cards, timeline, composer.
- Right inspector: changed files, checks, terminal preview.

The `github` and `notion` variants should be treated as reference directions only. They may inform specific details, but the primary implementation target is Codex Workbench.
