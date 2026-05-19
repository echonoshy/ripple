import assert from "node:assert/strict";

import {
  extractChangedFilePaths,
  mapTaskSummariesToWorkbenchSessions,
  messagesToTimelineEvents,
  sortWorkbenchSessions,
} from "./workbench";
import type { Message, TaskSummary } from "@/types";

function makeTask(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    task_id: "task-default",
    session_id: "task-default",
    title: "",
    model: "codex-medium",
    created_at: "2026-05-15T01:00:00.000Z",
    last_active: "2026-05-15T01:00:00.000Z",
    message_count: 0,
    status: "idle",
    changed_file_count: 0,
    pending_approval_count: 0,
    ...overrides,
  };
}

function testMapsBackendTasksToWorkbenchSummaries() {
  const tasks = mapTaskSummariesToWorkbenchSessions([
    makeTask({
      task_id: "legacy-task-auth",
      session_id: "srv-auth",
      title: "Refactor auth flow",
      status: "waiting_for_approval",
      message_count: 3,
      changed_file_count: 2,
      pending_approval_count: 1,
    }),
    makeTask({
      task_id: "legacy-task-empty",
      session_id: "srv-empty",
      title: "",
      status: "idle",
    }),
  ]);

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].sessionId, "srv-auth");
  assert.equal(tasks[0].title, "Refactor auth flow");
  assert.equal(tasks[0].status, "waiting_for_approval");
  assert.equal(tasks[0].messageCount, 3);
  assert.equal(tasks[0].changedFileCount, 2);
  assert.equal(tasks[0].pendingApprovalCount, 1);
  assert.equal(tasks[1].title, "Session srv-empty");
}

function testSortsApprovalTasksBeforeOrdinaryRunningTasks() {
  const sessions = mapTaskSummariesToWorkbenchSessions([
    makeTask({
      task_id: "legacy-task-running",
      session_id: "running",
      title: "Running session",
      status: "running",
      last_active: "2026-05-15T02:00:00.000Z",
    }),
    makeTask({
      task_id: "legacy-task-approval",
      session_id: "approval",
      title: "Approval session",
      status: "awaiting_permission",
      last_active: "2026-05-15T01:00:00.000Z",
      pending_approval_count: 1,
    }),
  ]);

  const sorted = sortWorkbenchSessions(sessions);

  assert.equal(sorted[0].sessionId, "approval");
  assert.equal(sorted[0].status, "waiting_for_approval");
  assert.equal(sorted[0].pendingApprovalCount, 1);
  assert.equal(sorted[1].sessionId, "running");
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

testMapsBackendTasksToWorkbenchSummaries();
testSortsApprovalTasksBeforeOrdinaryRunningTasks();
testMapsToolCallsIntoTimelineEvents();
testPlacesAssistantContentAfterItsToolCalls();
testExtractsChangedFilesFromToolCalls();

console.log("workbench tests passed");
