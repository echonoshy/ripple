import assert from "node:assert/strict";

import { mapSessionsToWorkbenchTasks, sortWorkbenchTasks } from "./workbench";
import type { Session } from "@/types";

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

testMapsSessionsToTaskSummaries();
testSortsApprovalTasksBeforeOrdinaryRunningTasks();

console.log("workbench tests passed");
