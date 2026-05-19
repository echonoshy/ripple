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

function renderWorkspaceNav() {
  return renderToStaticMarkup(
    <WorkspaceNav
      sessions={sessions}
      selectedSessionId="srv-9"
      activeView="sessions"
      isLoading={false}
      isGenerating={false}
      userId="default"
      onNewSession={noop}
      onSelectView={noop}
      onSelectSession={noop}
      onDeleteSession={noop}
      onOpenSettings={noop}
    />
  );
}

function testRendersAllSessionsWithoutDeadViewAllButton() {
  const html = renderWorkspaceNav();

  assert.match(html, /Session 9/);
  assert.doesNotMatch(html, />Idle</);
  assert.doesNotMatch(html, /View all tasks/);
  assert.doesNotMatch(html, />Tasks</);
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

testRendersAllSessionsWithoutDeadViewAllButton();
testUsesSessionIdSelectionNaming();
testSessionsHeaderDoesNotDuplicateNewSessionAction();

console.log("workspace nav tests passed");
