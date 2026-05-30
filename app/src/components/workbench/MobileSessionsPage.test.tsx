import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchSessionSummary } from "@/types";
import MobileSessionsPage from "./MobileSessionsPage";

const noop = () => {};
const mobileSessionsPageSource = readFileSync(
  new URL("./MobileSessionsPage.tsx", import.meta.url),
  "utf8"
);

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

  assert.doesNotMatch(html, /class="lucide lucide-message-circle"/);
}

function testHeaderActionsUseSharedGlassTreatment() {
  const html = renderMobileSessionsPage();

  assert.match(html, /bg-white\/68/);
  assert.match(html, /backdrop-blur-xl/);
  assert.match(
    mobileSessionsPageSource,
    /mobileHeaderActionClass =\s+"inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white\/70 bg-white\/68 text-\[#516070\]/
  );
  assert.match(mobileSessionsPageSource, /MessageSquarePlus/);
  assert.match(
    mobileSessionsPageSource,
    /aria-label="New session"[\s\S]*?<MessageCircleMore size=\{18\}/
  );
  assert.match(mobileSessionsPageSource, /Ellipsis/);
  assert.doesNotMatch(mobileSessionsPageSource, /<Plus size=\{18\}/);
  assert.doesNotMatch(mobileSessionsPageSource, /<SquarePen size=\{18\}/);
  assert.doesNotMatch(mobileSessionsPageSource, /<MoreHorizontal size=\{18\}/);
  assert.doesNotMatch(mobileSessionsPageSource, /<Settings2 size=\{18\}/);
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /aria-label="New session"[\s\S]*?<MessageSquarePlus size=\{18\}/
  );
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /aria-label="New session"[\s\S]*?border-\[#b8cdf8\]\/80 bg-\[#eef4ff\]\/78 text-\[#2463eb\]/
  );
  assert.doesNotMatch(html, /border-\[#2463eb\] bg-\[#2463eb\] text-white/);
}

function testSessionRowsDoNotClipOptionsMenu() {
  const html = renderMobileSessionsPage();
  const source = readFileSync(new URL("./MobileSessionsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(html, /overflow-hidden rounded-lg border/);
  assert.match(source, /getMeasuredViewportMenuPosition/);
  assert.match(source, /getMobileSessionMenuPosition/);
  assert.match(source, /activeMenuRef/);
  assert.match(source, /getBoundingClientRect\(\)\.height/);
  assert.match(source, /useLayoutEffect/);
  assert.match(source, /position: "fixed"/);
  assert.doesNotMatch(source, /absolute top-12 right-3/);
}

function testSessionOptionsMenuEscapesBlurredRowsWithPortal() {
  const source = readFileSync(new URL("./MobileSessionsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ createPortal \} from "react-dom"/);
  assert.match(source, /createPortal\(/);
  assert.match(source, /document\.body/);
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
testSessionOptionsMenuEscapesBlurredRowsWithPortal();
testRendersEmptyStateWithNewSessionAction();

console.log("mobile sessions page tests passed");
