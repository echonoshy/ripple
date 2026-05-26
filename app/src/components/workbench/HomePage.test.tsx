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
    pinned: false,
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
      onOpenSettings={noop}
    />
  );
}

function testHomeHasMobileSpecificCopy() {
  const html = renderHomePage();

  assert.match(html, />Ripple/);
  assert.match(html, />Settings/);
  assert.match(html, /sm:hidden[^>]*>New</);
  assert.match(html, /hidden sm:inline[^>]*>New session</);
  assert.match(html, />Sessions/);
  assert.match(html, />Files/);
  assert.match(html, />Connectors/);
  assert.match(html, />Automations/);
  assert.match(html, />API endpoint/);
  assert.match(html, /http:\/\/140\.143\.229\.103:8810\/v1/);
  assert.match(html, />Recent sessions</);
  assert.doesNotMatch(html, />Tasks</);
  assert.doesNotMatch(html, /tasks yet/);
}

testHomeHasMobileSpecificCopy();

console.log("home page tests passed");
