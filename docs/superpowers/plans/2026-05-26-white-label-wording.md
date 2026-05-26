# White-Label Wording Optimization (Scheme A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-brand/white-label the Ripple React/Tauri frontend by eliminating visible mentions of "Codex" and converting technical model IDs to elegant user-facing tier names.

**Architecture:** Implement a pure frontend UI display mapper `formatModelName` in `models.ts` and apply it to display components. Update hardcoded UI strings and event titles in `workbench.ts` to generic, neutral terms. Ensure backend APIs and communication protocols remain unchanged.

**Tech Stack:** React, TypeScript, Vite, Tauri

---

### Task 1: Add Model Mapping Helper and Test

**Files:**
- Create/Modify: `app/src/lib/models.ts`
- Modify: `app/src/lib/models.test.ts`

- [ ] **Step 1: Modify `app/src/lib/models.ts` to export model display names mapping and helper**

```typescript
export interface ModelOption {
  id: string;
  owned_by: string;
}

const CODEX_MODEL_ORDER = ["codex-low", "codex-medium", "codex-high", "codex-xhigh"];
const MODEL_ORDER_RANK = new Map(CODEX_MODEL_ORDER.map((id, index) => [id, index]));

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "codex-low": "Standard",
  "codex-medium": "Balanced",
  "codex-high": "Pro",
  "codex-xhigh": "Expert",
};

export function formatModelName(id: string): string {
  return MODEL_DISPLAY_NAMES[id] || id;
}

export function sortModelOptions<T extends { id: string }>(models: T[]): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const aRank = MODEL_ORDER_RANK.get(a.model.id);
      const bRank = MODEL_ORDER_RANK.get(b.model.id);

      if (aRank !== undefined && bRank !== undefined) {
        return aRank - bRank || a.index - b.index;
      }
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ model }) => model);
}
```

- [ ] **Step 2: Modify `app/src/lib/models.test.ts` to add test assertions for `formatModelName`**

```typescript
import assert from "node:assert/strict";

import { sortModelOptions, formatModelName } from "./models";

function testSortsCodexPresetsByReasoningEffort() {
  const sorted = sortModelOptions([
    { id: "codex-xhigh", owned_by: "ripple" },
    { id: "codex-high", owned_by: "ripple" },
    { id: "custom-model", owned_by: "ripple" },
    { id: "codex-low", owned_by: "ripple" },
    { id: "codex-medium", owned_by: "ripple" },
  ]);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["codex-low", "codex-medium", "codex-high", "codex-xhigh", "custom-model"]
  );
}

function testKeepsUnknownModelsInBackendOrder() {
  const sorted = sortModelOptions([
    { id: "z-model", owned_by: "ripple" },
    { id: "a-model", owned_by: "ripple" },
  ]);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["z-model", "a-model"]
  );
}

function testFormatModelName() {
  assert.equal(formatModelName("codex-low"), "Standard");
  assert.equal(formatModelName("codex-medium"), "Balanced");
  assert.equal(formatModelName("codex-high"), "Pro");
  assert.equal(formatModelName("codex-xhigh"), "Expert");
  assert.equal(formatModelName("custom-gpt"), "custom-gpt");
}

testSortsCodexPresetsByReasoningEffort();
testKeepsUnknownModelsInBackendOrder();
testFormatModelName();

console.log("model sorting and formatting tests passed");
```

- [ ] **Step 3: Run the unit test to verify it passes**

Run: `bun test app/src/lib/models.test.ts` (or node runner in workspace)
Expected: Success

---

### Task 2: Refactor Time-Line and Event Title Conversion

**Files:**
- Modify: `app/src/lib/workbench.ts`
- Modify: `app/src/lib/workbench.test.ts`

- [ ] **Step 1: Modify `app/src/lib/workbench.ts` to remove hardcoded Codex mentions**

Apply changes to:
- `runtimeBody` function (context_compaction body change)
- `runtimeTitle` function (warning/error/default title change)
- `mergeTimelineEvents` function (assistant titles change)

```typescript
// Modify inside runtimeBody:
  if (event.type === "context_compaction") {
    return "Compacted conversation context.";
  }

// Modify inside runtimeTitle:
function runtimeTitle(event: CodexRuntimeEvent): string {
  if (event.type === "tool_output_delta") {
    return event.kind === "file_change" ? "File output" : "Command output";
  }
  if (event.type === "file_change_patch_updated") return "File patch updated";
  if (event.type === "codex_warning") return "System warning";
  if (event.type === "codex_error") return "System error";
  if (event.type === "context_compaction") return "Context compacted";
  if (event.type === "codex_turn_diff_updated") return "Workspace diff";
  return "Runtime update";
}

// Modify inside mergeTimelineEvents (around line 500):
    if (message.role === "assistant" && message.content) {
      const hasTools = toolCalls.length > 0;
      events.push({
        id,
        type: hasTools ? "final_summary" : "assistant_message",
        title: hasTools ? "Response" : "Update",
        body: message.content,
        createdAt: message.created_at,
      });
    }
```

- [ ] **Step 2: Update assertions in `app/src/lib/workbench.test.ts`**

Update assertions:
- `assert.equal(events[1].title, "Codex response");` ➡️ `assert.equal(events[1].title, "Response");`
- `assert.equal(warningEvent.title, "Codex warning");` ➡️ `assert.equal(warningEvent.title, "System warning");`
- `title: hasTools ? "Codex response" : "Codex update"` ➡️ `title: hasTools ? "Response" : "Update"`

- [ ] **Step 3: Run the workbench test to verify all tests pass**

Run: `bun test app/src/lib/workbench.test.ts`
Expected: Success

---

### Task 3: De-brand UI Components

**Files:**
- Modify: `app/src/components/workbench/SessionPage.tsx`
- Modify: `app/src/components/workbench/SessionComposer.tsx`
- Modify: `app/src/components/workbench/SessionTimeline.tsx`
- Modify: `app/src/components/workbench/ConnectorsPage.tsx`
- Modify: `app/src/App.tsx`

- [ ] **Step 1: Apply changes to `app/src/components/workbench/SessionPage.tsx`**

Import `formatModelName`:
`import { formatModelName } from "@/lib/models";`

Modify mobile/small screen header:
```typescript
          <div className="mt-0.5 flex min-w-0 items-center justify-center gap-1.5 text-[11px] leading-4 text-[#7a8496]">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isGenerating ? "animate-pulse bg-[#2f6bff]" : "bg-[#2fbf71]"
              }`}
            />
            <span className="truncate">{isGenerating ? "Working..." : formatModelName(selectedModel)}</span>
          </div>
```

- [ ] **Step 2: Apply changes to `app/src/components/workbench/SessionComposer.tsx`**

Import `formatModelName`:
`import { formatModelName } from "@/lib/models";`

Modify text label for Selected Model (large screen):
```typescript
              <button
                type="button"
                aria-label="Select model"
                title={`Model: ${formatModelName(selectedModel)}`}
                onClick={onToggleModelDropdown}
                className="hidden h-8 max-w-[180px] items-center gap-1.5 rounded-full px-2 font-[family-name:var(--font-mono)] text-xs font-medium text-[#111827] hover:bg-[#f7f8fa] sm:inline-flex"
              >
                <span className="truncate">{formatModelName(selectedModel)}</span>
```

Modify text rendering for list options in dropdown menu (both large and small dropdowns):
```typescript
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => onSelectModel(model.id)}
                        className={`flex w-full items-center rounded px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs hover:bg-[#f7f8fa] ${
                          selectedModel === model.id
                            ? "bg-[#eef3ff] text-[#2457e6]"
                            : "text-[#111827]"
                        }`}
                      >
                        {formatModelName(model.id)}
                      </button>
```

Modify Textarea Placeholders:
```typescript
            placeholder={
              isGenerating
                ? "Working..."
                : isBlocked
                  ? "Draft your next message..."
                  : hasSession
                    ? "Ask anything..."
                    : "Ask anything..."
            }
```

- [ ] **Step 3: Apply changes to `app/src/components/workbench/SessionTimeline.tsx`**

Modify empty state and generating message:
```typescript
  if (events.length === 0 && !isGenerating) {
    return (
      <div className="relative min-h-[140px] pl-8">
        <div className="absolute top-2 bottom-2 left-[11px] w-px bg-[#dfe6f4]" />
        <div className="relative py-2">
          <span className="absolute top-2.5 -left-8 flex h-6 w-6 items-center justify-center rounded-full border border-[#c8d6ff] bg-white text-[#2f6bff] shadow-[0_8px_18px_rgba(64,92,255,0.12)]">
            <span className="h-2 w-2 rounded-full bg-current" />
          </span>
          <div className="text-[12px] font-semibold text-[#111827]">Ready</div>
          <div className="mt-1 max-w-xl text-[12px] leading-5 text-[#667085]">
            Start a session and your workspace activity will appear here as a timeline.
          </div>
        </div>
      </div>
    );
  }
```

Modify Loader label (around line 172):
```typescript
          <div className="flex items-center gap-2 text-[12px] text-[#667085]">
            <Bot size={13} />
            {feishuAuthWaiting
              ? `正在等待浏览器中的${feishuAuthWaiting.label}完成... 已等待 ${feishuAuthWaiting.elapsedSeconds} 秒`
              : "Starting work..."}
          </div>
```

- [ ] **Step 4: Apply changes to `app/src/components/workbench/ConnectorsPage.tsx`**

Modify section capability helper:
```typescript
                  <p className="mt-1 text-[11px] leading-4 text-[#667085]">
                    {section.kind === "runtime_capability"
                      ? "Server-side capabilities shared by the runtime."
                      : "Per-user credentials stored inside the current sandbox boundary."}
                  </p>
```

- [ ] **Step 5: Apply changes to `app/src/App.tsx`**

Modify current session metadata titles:
```typescript
  const inferredCurrentSession = useMemo(
    () =>
      sessionId && !selectedExistingSession
        ? {
            sessionId,
            title: "Current session",
            pinned: false,
            status: selectedSessionRuntimeStatus || ("idle" as const),
            model: selectedModel,
            lastActivityAt: new Date().toISOString(),
            messageCount: messages.length,
            changedFileCount: 0,
            pendingApprovalCount: 0,
          }
        : null,
...
  const inferredRunningSessions = useMemo(
    () =>
      runningSessionIds
        .filter(
          (activeSessionId) =>
            activeSessionId !== sessionId &&
            !baseWorkbenchSessions.some((session) => session.sessionId === activeSessionId)
        )
        .map((activeSessionId) => ({
          sessionId: activeSessionId,
          title: "Running session",
          pinned: false,
          status: "running" as const,
          model: selectedModel,
          lastActivityAt: new Date().toISOString(),
          messageCount: 0,
          changedFileCount: 0,
          pendingApprovalCount: 0,
        })),
```

---

### Task 4: Align and Fix Frontend Unit Tests

**Files:**
- Modify: `app/src/components/workbench/SessionPage.test.tsx`
- Modify: `app/src/components/workbench/SessionPagePlan.test.tsx`
- Modify: `app/src/components/workbench/SessionComposer.test.tsx`

- [ ] **Step 1: Check unit tests assertions and update as necessary**

Verify and modify `app/src/components/workbench/SessionPage.test.tsx`:
```typescript
// Replace title check: "Codex update" -> "Update" (in mock data/assert)
// Modify around line 63:
          title: "Update",
```

Verify and modify `app/src/components/workbench/SessionComposer.test.tsx`:
```typescript
// Replace:
// assert.match(html, />codex-high</);
// assert.match(html, />codex-medium</);
// to assert mapped names:
// assert.match(html, />Pro</);
// assert.match(html, />Balanced</);
```

- [ ] **Step 2: Run all workspace tests**

Run command in project root:
`bun run test` (or run relevant files)

- [ ] **Step 3: Run Linters & Formatter**

Run command in `app/`:
`bun run lint && bun run format:check` (or `bun run format`)
If there are any formatting issues, resolve them.
