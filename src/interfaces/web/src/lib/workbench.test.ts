import assert from "node:assert/strict";

import {
  applyCurrentSessionRuntimeStatus,
  codexRuntimeEventToTimelineEvent,
  extractChangedFilePaths,
  mapSessionSummariesToWorkbenchSessions,
  messagesToTimelineEvents,
  sortWorkbenchSessions,
} from "./workbench";
import type { CodexRuntimeEvent, Message, SessionSummary } from "@/types";

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "session-default",
    title: "",
    model: "codex-medium",
    createdAt: "2026-05-15T01:00:00.000Z",
    lastActiveAt: "2026-05-15T01:00:00.000Z",
    messageCount: 0,
    status: "idle",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    ...overrides,
  };
}

function testMapsSessionSummariesToWorkbenchSummaries() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-auth",
      title: "Refactor auth flow",
      status: "waiting_for_approval",
      messageCount: 3,
      changedFileCount: 2,
      pendingApprovalCount: 1,
    }),
    makeSession({
      sessionId: "srv-empty",
      title: "",
      status: "idle",
    }),
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, "srv-auth");
  assert.equal(sessions[0].title, "Refactor auth flow");
  assert.equal(sessions[0].status, "waiting_for_approval");
  assert.equal(sessions[0].messageCount, 3);
  assert.equal(sessions[0].changedFileCount, 2);
  assert.equal(sessions[0].pendingApprovalCount, 1);
  assert.equal(sessions[1].title, "Session srv-empty");
}

function testSortsApprovalSessionsBeforeOrdinaryRunningSessions() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "running",
      title: "Running session",
      status: "running",
      lastActiveAt: "2026-05-15T02:00:00.000Z",
    }),
    makeSession({
      sessionId: "approval",
      title: "Approval session",
      status: "awaiting_permission",
      lastActiveAt: "2026-05-15T01:00:00.000Z",
      pendingApprovalCount: 1,
    }),
  ]);

  const sorted = sortWorkbenchSessions(sessions);

  assert.equal(sorted[0].sessionId, "approval");
  assert.equal(sorted[0].status, "waiting_for_approval");
  assert.equal(sorted[0].pendingApprovalCount, 1);
  assert.equal(sorted[1].sessionId, "running");
}

function testAppliesCurrentRunningStatusToExistingSession() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-current",
      title: "Current session",
      status: "idle",
    }),
    makeSession({
      sessionId: "srv-other",
      title: "Other session",
      status: "idle",
    }),
  ]);

  const updated = applyCurrentSessionRuntimeStatus(sessions, "srv-current", "running");

  assert.equal(updated[0].sessionId, "srv-current");
  assert.equal(updated[0].status, "running");
  assert.equal(updated[1].status, "idle");
}

function testAppliesCurrentApprovalStatusToExistingSession() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-current",
      title: "Current session",
      status: "idle",
    }),
  ]);

  const updated = applyCurrentSessionRuntimeStatus(sessions, "srv-current", "waiting_for_approval");

  assert.equal(updated[0].status, "waiting_for_approval");
}

function testMapsToolCallsIntoTimelineEvents() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          name: "command_execution",
          arguments: { command: "bun run lint", cwd: "/workspace/src/interfaces/web" },
          status: "success",
          result: "very long command output that should not be shown in the main timeline",
        },
        {
          id: "tool-2",
          name: "file_change",
          arguments: {
            changes: [
              { path: "/workspace/src/interfaces/web/src/App.tsx" },
              { path: "src/interfaces/web/src/components/workbench/InspectorPanel.tsx" },
            ],
          },
          status: "success",
        },
      ],
    },
  ];

  const events = messagesToTimelineEvents(messages);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_call");
  assert.equal(events[0].title, "Used 2 tools");
  assert.match(events[0].body, /bun run lint/);
  assert.match(events[0].body, /InspectorPanel/);
  assert.doesNotMatch(events[0].body, /very long command output/);
}

function testPlacesAssistantContentAfterItsToolCalls() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Done.\n\n- One\n- Two",
      toolCalls: [
        {
          id: "tool-1",
          name: "command_execution",
          arguments: { command: "bun run build" },
          status: "success",
          result: "ok",
        },
      ],
    },
  ];

  const events = messagesToTimelineEvents(messages);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "tool_call");
  assert.equal(events[1].type, "final_summary");
  assert.equal(events[1].title, "Final answer");
  assert.equal(events[1].body, "Done.\n\n- One\n- Two");
}

function testExtractsChangedFilesFromToolCalls() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          name: "file_change",
          arguments: {
            changes: [
              { path: "/workspace/a.ts" },
              { path: "/workspace/b.ts" },
              { path: "/workspace/a.ts" },
            ],
          },
          status: "success",
        },
      ],
    },
  ];

  assert.deepEqual(extractChangedFilePaths(messages), ["/workspace/a.ts", "/workspace/b.ts"]);
}

function testMapsCodexRuntimeEventsIntoTimelineEvents() {
  const command: CodexRuntimeEvent = {
    type: "tool_output_delta",
    id: "cmd-1",
    kind: "command_execution",
    delta: "pytest -q",
    stream: "stdout",
  };
  const commandEvent = codexRuntimeEventToTimelineEvent(command, {
    id: "runtime-1",
    createdAt: "2026-05-19T00:00:00.000Z",
  });

  assert.equal(commandEvent.id, "runtime-1");
  assert.equal(commandEvent.type, "command");
  assert.equal(commandEvent.title, "Command output");
  assert.equal(commandEvent.body, "pytest -q");
  assert.equal(commandEvent.status, "stdout");
  assert.equal(commandEvent.createdAt, "2026-05-19T00:00:00.000Z");

  const patchEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "file_change_patch_updated",
      id: "file-1",
      patch: "@@ -1 +1 @@",
    },
    { id: "runtime-2" }
  );
  assert.equal(patchEvent.type, "file_change");
  assert.equal(patchEvent.title, "File patch updated");
  assert.match(patchEvent.body, /@@ -1/);

  const warningEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "codex_warning",
      message: "context is getting full",
    },
    { id: "runtime-3" }
  );
  assert.equal(warningEvent.type, "warning");
  assert.equal(warningEvent.title, "Codex warning");
  assert.equal(warningEvent.body, "context is getting full");

  const compactEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "context_compaction",
      id: "compact-1",
      status: "completed",
    },
    { id: "runtime-4" }
  );
  assert.equal(compactEvent.type, "context_compaction");
  assert.equal(compactEvent.title, "Context compacted");
  assert.equal(compactEvent.status, "completed");
}

testMapsSessionSummariesToWorkbenchSummaries();
testSortsApprovalSessionsBeforeOrdinaryRunningSessions();
testAppliesCurrentRunningStatusToExistingSession();
testAppliesCurrentApprovalStatusToExistingSession();
testMapsToolCallsIntoTimelineEvents();
testPlacesAssistantContentAfterItsToolCalls();
testExtractsChangedFilesFromToolCalls();
testMapsCodexRuntimeEventsIntoTimelineEvents();

console.log("workbench tests passed");
