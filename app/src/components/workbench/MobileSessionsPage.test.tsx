import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchSessionSummary } from "@/types";
import MobileSessionsPage from "./MobileSessionsPage";

const noop = () => {};

const sessions: WorkbenchSessionSummary[] = [
  {
    sessionId: "srv-1",
    title: "Mobile redesign",
    status: "idle",
    model: "codex-medium",
    lastActivityAt: "2026-05-17T00:00:00Z",
    messageCount: 4,
    changedFileCount: 2,
    pendingApprovalCount: 0,
  },
];

function renderMobileSessionsPage(
  overrides: Partial<React.ComponentProps<typeof MobileSessionsPage>> = {}
) {
  return renderToStaticMarkup(
    <MobileSessionsPage
      sessions={sessions}
      isLoading={false}
      selectedSessionId="srv-1"
      onNewSession={noop}
      onSelectSession={noop}
      {...overrides}
    />
  );
}

function testRendersChatAppStyleSessionList() {
  const html = renderMobileSessionsPage();

  assert.match(html, />Session</);
  assert.match(html, /aria-label="Search sessions"/);
  assert.match(html, /aria-label="New session"/);
  assert.match(html, />Mobile redesign</);
  assert.match(html, /4 messages · 2 files · idle/);
  assert.match(html, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
}

function testRendersEmptyStateWithNewSessionAction() {
  const html = renderMobileSessionsPage({ sessions: [], selectedSessionId: null });

  assert.match(html, />No sessions yet</);
  assert.match(html, />New session</);
}

testRendersChatAppStyleSessionList();
testRendersEmptyStateWithNewSessionAction();

console.log("mobile sessions page tests passed");
