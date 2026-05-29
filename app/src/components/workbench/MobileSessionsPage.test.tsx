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
    pinned: false,
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
      onDeleteSession={noop}
      onUpdateSession={async () => {}}
      {...overrides}
    />
  );
}

function testRendersChatAppStyleSessionList() {
  const html = renderMobileSessionsPage();

  assert.match(html, />Ripple</);
  assert.match(html, /aria-label="Search sessions"/);
  assert.match(html, /aria-label="New session"/);
  assert.match(html, />Mobile redesign</);
  assert.match(html, /4 messages · 2 files/);
  assert.doesNotMatch(html, /idle/);
  assert.match(html, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
}

function testUsesQuietAgentControlPlaneStyling() {
  const html = renderMobileSessionsPage();

  assert.match(html, /bg-white\/70/);
  assert.match(html, /backdrop-blur-xl/);
  assert.match(html, /shadow-\[0_8px_24px_rgba\(44,63,123,0\.06\)\]/);
  assert.match(html, /rounded-lg/);
  assert.doesNotMatch(html, /bg-gradient/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /radial-gradient/);
  assert.doesNotMatch(html, /rounded-\[18px\]/);
}

function testSessionRowsRemoveRepeatedChatIcon() {
  const html = renderMobileSessionsPage();

  assert.doesNotMatch(html, /lucide-message-circle/);
}

function testHeaderActionsUseSharedGlassTreatment() {
  const html = renderMobileSessionsPage();

  assert.match(html, /bg-white\/68/);
  assert.match(html, /backdrop-blur-xl/);
  assert.doesNotMatch(html, /border-\[#2463eb\] bg-\[#2463eb\] text-white/);
}

function testSessionRowsDoNotClipOptionsMenu() {
  const html = renderMobileSessionsPage();

  assert.doesNotMatch(html, /overflow-hidden rounded-lg border/);
}

function testRendersEmptyStateWithNewSessionAction() {
  const html = renderMobileSessionsPage({ sessions: [], selectedSessionId: null });

  assert.match(html, />No sessions yet</);
  assert.match(html, />New session</);
}

testRendersChatAppStyleSessionList();
testUsesQuietAgentControlPlaneStyling();
testSessionRowsRemoveRepeatedChatIcon();
testHeaderActionsUseSharedGlassTreatment();
testSessionRowsDoNotClipOptionsMenu();
testRendersEmptyStateWithNewSessionAction();

console.log("mobile sessions page tests passed");
