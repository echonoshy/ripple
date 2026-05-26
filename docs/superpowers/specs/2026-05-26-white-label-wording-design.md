# Frontend White-Label Wording Optimization (Scheme A)

## Goal
The goal of this design is to de-brand / white-label the Ripple frontend by removing occurrences of "Codex" or "codex" visible to the end users, replacing them with generic, professional, and context-aware terms, without breaking the underlying API, types, or backward-compatibility.

## Architecture
This is a pure frontend presentation layer (UI Display Layer) mapping. No backend endpoints, API payloads, or state-persisted model IDs (like `codex-medium`) are changed in API communications.
Instead:
1. We introduce a mapping helper in `models.ts` to convert technical model IDs to elegant user-facing tier names.
2. We update components to render the mapped strings rather than raw model IDs or hardcoded "Codex" titles.

## Components & Changes

### 1. Model ID Mapping (`app/src/lib/models.ts`)
*   Add a mapping record for known models:
    *   `codex-low` ➡️ `Standard`
    *   `codex-medium` ➡️ `Balanced`
    *   `codex-high` ➡️ `Pro`
    *   `codex-xhigh` ➡️ `Expert`
*   Add a helper function `formatModelName(id: string): string` to perform this mapping with a fallback to the original ID.

### 2. Session Page & Composer Components
*   **`app/src/components/workbench/SessionPage.tsx`**:
    *   Map the header model text: `{isGenerating ? "Codex is working" : selectedModel}` ➡️ `{isGenerating ? "Working..." : formatModelName(selectedModel)}`.
*   **`app/src/components/workbench/SessionComposer.tsx`**:
    *   Map selection button text: `{selectedModel}` ➡️ `{formatModelName(selectedModel)}`.
    *   Map dropdown option text: `{model.id}` ➡️ `{formatModelName(model.id)}`.
    *   Map input placeholder state:
        *   `"Codex is working..."` ➡️ `"Working..."`
        *   `"Ask Codex..."` ➡️ `"Ask anything..."`

### 3. Timeline & Activity Processing
*   **`app/src/components/workbench/SessionTimeline.tsx`**:
    *   Update timeline empty state message: `"Start a session and Codex activity will appear here as a timeline."` ➡️ `"Start a session and your workspace activity will appear here as a timeline."`
    *   Update running state loader text: `"Codex is starting work..."` ➡️ `"Starting work..."`
*   **`app/src/lib/workbench.ts`**:
    *   Update `runtimeTitle`:
        *   `"Codex warning"` ➡️ `"System warning"`
        *   `"Codex error"` ➡️ `"System error"`
        *   `"Codex runtime update"` ➡️ `"Runtime update"`
    *   Update `runtimeBody` compaction event:
        *   `"Codex compacted conversation context."` ➡️ `"Compacted conversation context."`
    *   Update `mergeTimelineEvents` assistant titles:
        *   `"Codex response"` ➡️ `"Response"`
        *   `"Codex update"` ➡️ `"Update"`

### 4. Connectors & General UI
*   **`app/src/components/workbench/ConnectorsPage.tsx`**:
    *   Update capabilities header description: `"Server-side Codex capabilities shared by the runtime."` ➡️ `"Server-side capabilities shared by the runtime."`
*   **`app/src/App.tsx`**:
    *   Inferred sessions tracking:
        *   `"Current Codex session"` ➡️ `"Current session"`
        *   `"Running Codex session"` ➡️ `"Running session"`

## Testing & Verification
*   We must ensure the React project still compiles properly (`bun run build` and `bun run lint`).
*   Any snapshot or text assertions in frontend unit tests (`*.test.tsx`, `*.test.ts`) that check for hardcoded "Codex" must be updated to match the new mapped text.
