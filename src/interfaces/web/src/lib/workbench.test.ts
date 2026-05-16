import assert from "node:assert/strict";

import {
  extractChangedFilePaths,
  mapTasksToWorkbenchTasks,
  mapSessionsToWorkbenchTasks,
  messagesToTimelineEvents,
  sortWorkbenchTasks,
} from "./workbench";
import type { Message, Session, TaskSummary } from "@/types";

function makeSession(overrides: Partial<Session>): Session {
  return {
    session_id: "session-default",
    title: "",
    model: "codex-medium",
    created_at: "2026-05-15T01:00:00.000Z",
    last_active: "2026-05-15T01:00:00.000Z",
    message_count: 0,
    status: "idle",
    ...overrides,
  };
}

function testMapsSessionsToTaskSummaries() {
  const tasks = mapSessionsToWorkbenchTasks([
    makeSession({
      session_id: "srv-123456789",
      title: "Update web workbench",
      status: "running",
      message_count: 4,
    }),
    makeSession({
      session_id: "srv-untitled",
      title: "",
      status: "active",
      message_count: 1,
    }),
  ]);

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "srv-123456789");
  assert.equal(tasks[0].title, "Update web workbench");
  assert.equal(tasks[0].status, "running");
  assert.equal(tasks[0].model, "codex-medium");
  assert.equal(tasks[0].messageCount, 4);
  assert.equal(tasks[1].title, "Session srv-untitled");
  assert.equal(tasks[1].status, "idle");
}

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
  const tasks = mapTasksToWorkbenchTasks([
    makeTask({
      task_id: "task-auth",
      session_id: "task-auth",
      title: "Refactor auth flow",
      status: "waiting_for_approval",
      message_count: 3,
      changed_file_count: 2,
      pending_approval_count: 1,
    }),
    makeTask({
      task_id: "task-empty",
      session_id: "task-empty",
      title: "",
      status: "idle",
    }),
  ]);

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "task-auth");
  assert.equal(tasks[0].title, "Refactor auth flow");
  assert.equal(tasks[0].status, "waiting_for_approval");
  assert.equal(tasks[0].messageCount, 3);
  assert.equal(tasks[0].changedFileCount, 2);
  assert.equal(tasks[0].pendingApprovalCount, 1);
  assert.equal(tasks[1].title, "Task task-empty");
}

function testSortsApprovalTasksBeforeOrdinaryRunningTasks() {
  const tasks = mapSessionsToWorkbenchTasks([
    makeSession({
      session_id: "running",
      title: "Running session",
      status: "running",
      last_active: "2026-05-15T02:00:00.000Z",
    }),
    makeSession({
      session_id: "approval",
      title: "Approval session",
      status: "awaiting_permission",
      last_active: "2026-05-15T01:00:00.000Z",
    }),
  ]);

  const sorted = sortWorkbenchTasks(tasks);

  assert.equal(sorted[0].id, "approval");
  assert.equal(sorted[0].status, "waiting_for_approval");
  assert.equal(sorted[0].pendingApprovalCount, 1);
  assert.equal(sorted[1].id, "running");
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
          result: JSON.stringify({ success: true, duration_ms: 1200 }),
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

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "command");
  assert.equal(events[0].title, "Ran command");
  assert.match(events[0].body, /bun run lint/);
  assert.equal(events[1].type, "file_change");
  assert.equal(events[1].title, "Changed files");
  assert.match(events[1].body, /InspectorPanel/);
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
  assert.equal(events[0].type, "command");
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

testMapsSessionsToTaskSummaries();
testMapsBackendTasksToWorkbenchSummaries();
testSortsApprovalTasksBeforeOrdinaryRunningTasks();
testMapsToolCallsIntoTimelineEvents();
testPlacesAssistantContentAfterItsToolCalls();
testExtractsChangedFilesFromToolCalls();

console.log("workbench tests passed");
