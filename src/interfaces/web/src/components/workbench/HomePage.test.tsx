import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchSessionSummary } from "@/types";
import HomePage from "./HomePage";

function noop() {}

const sessions: WorkbenchSessionSummary[] = [
  {
    sessionId: "srv-1",
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
      sessions={sessions}
      isLoadingSessions={false}
      onNewSession={noop}
      onSelectSession={noop}
      onSelectView={noop}
    />
  );
}

function testHomeHasMobileSpecificCopy() {
  const html = renderHomePage();

  assert.match(html, /sm:hidden[^>]*>Workspace</);
  assert.match(html, /hidden sm:inline[^>]*>Home</);
  assert.match(html, /sm:hidden[^>]*>New</);
  assert.match(html, /hidden sm:inline[^>]*>New Session</);
  assert.match(html, /sm:hidden[^>]*>Apps</);
  assert.match(html, /sm:hidden[^>]*>Ready</);
  assert.match(html, /sm:hidden[^>]*>Recent</);
  assert.match(html, /hidden sm:inline[^>]*>Recent sessions</);
  assert.doesNotMatch(html, />Tasks</);
  assert.doesNotMatch(html, /tasks yet/);
}

testHomeHasMobileSpecificCopy();

console.log("home page tests passed");
