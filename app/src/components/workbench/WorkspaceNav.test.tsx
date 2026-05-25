import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchSessionSummary } from "@/types";
import WorkspaceNav from "./WorkspaceNav";

function noop() {}

const sessions: WorkbenchSessionSummary[] = Array.from({ length: 9 }, (_, index) => ({
  sessionId: `srv-${index + 1}`,
  title: `Session ${index + 1}`,
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
    activeView: "sessions" as const,
    isLoading: false,
    isGenerating: false,
    userId: "default",
    onNewSession: noop,
    onSelectView: noop,
    onSelectSession: noop,
    onDeleteSession: noop,
    onOpenSettings: noop,
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
  assert.match(html, />Automations</);
  assert.match(html, />Sessions</);
  assert.match(html, />New Session</);
}

function testUsesSessionIdSelectionNaming() {
  const html = renderWorkspaceNav();

  assert.match(html, /Session 9/);
  assert.match(html, /bg-\[#eef4ff\]/);
}

function testSessionsHeaderDoesNotDuplicateNewSessionAction() {
  const html = renderWorkspaceNav();

  assert.equal((html.match(/lucide-plus/g) || []).length, 1);
}

function testNewSessionStaysAvailableWhileAnotherSessionRuns() {
  const html = renderWorkspaceNav({ isGenerating: true });

  assert.match(html, />New Session</);
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
testNewSessionStaysAvailableWhileAnotherSessionRuns();
testSessionAttentionUsesDotsInsteadOfStatusLabels();
testRendersSessionActivityTime();
testSessionLoadErrorDoesNotLookLikeEmptyState();

console.log("workspace nav tests passed");
