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
      onSelectView={noop}
      onOpenSettings={noop}
      onUserIdChange={noop}
    />
  );
}

function testHomePageHasExpectedSpecificCopy() {
  const html = renderHomePage();

  assert.match(html, />Ripple/);
  assert.match(html, />Settings/);
  assert.match(html, />Sessions/);
  assert.match(html, />Files/);
  assert.match(html, />Connectors/);
  assert.match(html, />Automations/);
  assert.match(html, />API endpoint/);
  assert.match(html, /http:\/\/140\.143\.229\.103:8810\/v1/);
  assert.match(html, />Sandbox Status</);
  assert.doesNotMatch(html, />Tasks</);
  assert.doesNotMatch(html, /tasks yet/);
}

function testHomePageReservesMobileTopSafeArea() {
  const html = renderHomePage();

  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),16px\)\]/);
}

testHomePageHasExpectedSpecificCopy();
testHomePageReservesMobileTopSafeArea();

console.log("home page tests passed");
