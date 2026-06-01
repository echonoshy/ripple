import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchSessionSummary } from "@/types";
import WorkspaceNav from "./WorkspaceNav";

function noop() {}

const sessions: WorkbenchSessionSummary[] = Array.from({ length: 9 }, (_, index) => ({
  sessionId: `srv-${index + 1}`,
  title: `Session ${index + 1}`,
  pinned: false,
  status: "idle",
  model: "codex-medium",
  lastActivityAt: `2026-05-17T00:0${Math.min(index, 9)}:00Z`,
  messageCount: index,
  changedFileCount: 0,
  pendingApprovalCount: 0,
}));

function renderWorkspaceNav(overrides: Partial<React.ComponentProps<typeof WorkspaceNav>> = {}) {
  const props = {
    sessions,
    selectedSessionId: "srv-9",
    isLoading: false,
    onNewSession: noop,
    onSelectSession: noop,
    onDeleteSession: noop,
    onUpdateSession: async () => {},
    ...overrides,
  } as React.ComponentProps<typeof WorkspaceNav> & { sessionLoadError?: string | null };

  return renderToStaticMarkup(<WorkspaceNav {...props} />);
}

function testRendersAllSessionsWithoutDeadViewAllButton() {
  const html = renderWorkspaceNav();

  assert.match(html, /Session 9/);
  assert.doesNotMatch(html, />Idle</);
  assert.doesNotMatch(html, /View all tasks/);
  assert.doesNotMatch(html, />Tasks</);
  assert.doesNotMatch(html, />Automations</);
  assert.doesNotMatch(html, />Connectors</);
  assert.doesNotMatch(html, />Files</);
  assert.doesNotMatch(html, />Settings</);
  assert.match(html, /data-ripple-session-rail="true"/);
  assert.match(html, />Sessions</);
  assert.match(html, />New session</);
}

function testUsesSessionIdSelectionNaming() {
  const html = renderWorkspaceNav();

  assert.match(html, /Session 9/);
  assert.match(html, /border-\[#2463eb\]\/10/);
}

function testSessionsHeaderDoesNotDuplicateNewSessionAction() {
  const html = renderWorkspaceNav();

  assert.equal((html.match(/lucide-plus/g) || []).length, 1);
}

function testSessionRailCanCollapseFromHeader() {
  const html = renderWorkspaceNav({ onCollapse: noop });

  assert.match(html, /aria-label="Collapse session list"/);
  assert.match(html, /title="Collapse session list"/);
  assert.match(html, /lucide-chevron-left/);
}

function testNewSessionStaysAvailableWhileAnotherSessionRuns() {
  const html = renderWorkspaceNav();

  assert.match(html, />New session</);
  assert.doesNotMatch(html, /disabled=""/);
}

function testSessionAttentionUsesDotsInsteadOfStatusLabels() {
  const html = renderWorkspaceNav({
    sessions: [
      {
        ...sessions[0],
        attention: "needs_input",
        status: "waiting_for_user",
      },
    ],
  });

  assert.match(html, /aria-label="Needs input"/);
  assert.doesNotMatch(html, />Needs input</);
  assert.doesNotMatch(html, />Running</);
}

function testRendersSessionActivityTime() {
  const html = renderWorkspaceNav({
    sessions: [
      {
        ...sessions[0],
        lastActivityAt: new Date(2000, 0, 2, 12, 0).toISOString(),
      },
    ],
  });

  assert.match(html, /Jan 2, 2000/);
}

function testSessionLoadErrorDoesNotLookLikeEmptyState() {
  const html = renderWorkspaceNav({
    sessions: [],
    selectedSessionId: null,
    sessionLoadError: "无法加载历史 session",
  } as Partial<React.ComponentProps<typeof WorkspaceNav>>);

  assert.match(html, /无法加载历史 session/);
  assert.doesNotMatch(html, /No sessions yet/);
}

testRendersAllSessionsWithoutDeadViewAllButton();
testUsesSessionIdSelectionNaming();
testSessionsHeaderDoesNotDuplicateNewSessionAction();
testSessionRailCanCollapseFromHeader();
testNewSessionStaysAvailableWhileAnotherSessionRuns();
testSessionAttentionUsesDotsInsteadOfStatusLabels();
testRendersSessionActivityTime();
testSessionLoadErrorDoesNotLookLikeEmptyState();

function testRendersPinnedSessionWithIcon() {
  const html = renderWorkspaceNav({
    sessions: [
      {
        sessionId: "pinned-1",
        title: "Pinned Session",
        pinned: true,
        status: "idle",
        model: "codex-medium",
        lastActivityAt: "2026-05-17T00:00:00Z",
        messageCount: 0,
        changedFileCount: 0,
        pendingApprovalCount: 0,
      },
    ],
  });

  assert.match(html, /Pinned Session/);
  // Matches lucide-pin icon (uses lucide-pin class or SVG markup)
  assert.match(html, /lucide-pin/);
}

function testRendersUnpinnedSessionWithoutPinIcon() {
  const html = renderWorkspaceNav({
    sessions: [
      {
        sessionId: "unpinned-1",
        title: "Unpinned Session",
        pinned: false,
        status: "idle",
        model: "codex-medium",
        lastActivityAt: "2026-05-17T00:00:00Z",
        messageCount: 0,
        changedFileCount: 0,
        pendingApprovalCount: 0,
      },
    ],
  });

  assert.match(html, /Unpinned Session/);
  assert.doesNotMatch(html, /lucide-pin/);
}

function testRendersSessionOptionsButton() {
  const html = renderWorkspaceNav({
    sessions: [
      {
        sessionId: "sess-1",
        title: "Session 1",
        pinned: false,
        status: "idle",
        model: "codex-medium",
        lastActivityAt: "2026-05-17T00:00:00Z",
        messageCount: 0,
        changedFileCount: 0,
        pendingApprovalCount: 0,
      },
    ],
  });

  assert.match(html, /title="Session options"/);
}

function testSessionRailDoesNotRenderAccountChrome() {
  const html = renderWorkspaceNav();

  assert.doesNotMatch(html, /Active Sandbox/);
  assert.doesNotMatch(html, /Token Usage Stats/);
  assert.doesNotMatch(html, /Settings for/);
}

testRendersPinnedSessionWithIcon();
testRendersUnpinnedSessionWithoutPinIcon();
testRendersSessionOptionsButton();
testSessionRailDoesNotRenderAccountChrome();

console.log("workspace nav tests passed");
