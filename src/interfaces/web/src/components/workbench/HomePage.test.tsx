import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchTaskSummary } from "@/types";
import HomePage from "./HomePage";

function noop() {}

const tasks: WorkbenchTaskSummary[] = [
  {
    id: "task-1",
    title: "Review mobile copy",
    status: "idle",
    model: "codex-medium",
    lastActivityAt: "2026-05-17T00:00:00Z",
    messageCount: 2,
    changedFileCount: 0,
    pendingApprovalCount: 0,
  },
];

function renderHomePage() {
  return renderToStaticMarkup(
    <HomePage
      userId="default"
      tasks={tasks}
      isLoadingTasks={false}
      onNewTask={noop}
      onSelectTask={noop}
      onSelectView={noop}
    />
  );
}

function testHomeHasMobileSpecificCopy() {
  const html = renderHomePage();

  assert.match(html, /sm:hidden[^>]*>Workspace</);
  assert.match(html, /hidden sm:inline[^>]*>Home</);
  assert.match(html, /sm:hidden[^>]*>New</);
  assert.match(html, /hidden sm:inline[^>]*>New Task</);
  assert.match(html, /sm:hidden[^>]*>Apps</);
  assert.match(html, /sm:hidden[^>]*>Ready</);
  assert.match(html, /sm:hidden[^>]*>Recent</);
  assert.match(html, /hidden sm:inline[^>]*>Recent tasks</);
}

testHomeHasMobileSpecificCopy();

console.log("home page tests passed");
