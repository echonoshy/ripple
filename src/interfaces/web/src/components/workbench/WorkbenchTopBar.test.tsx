import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchTopBar from "./WorkbenchTopBar";

function noop() {}

function renderTopBar({ pendingApprovalCount = 0 }: { pendingApprovalCount?: number } = {}) {
  return renderToStaticMarkup(
    <WorkbenchTopBar
      taskTitle="Current task"
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      isContextWarning={false}
      sessionId="task-123"
      sessionIdCopied={false}
      pendingApprovalCount={pendingApprovalCount}
      onCopySessionId={noop}
      onOpenNav={noop}
    />
  );
}

function testOmitsRedundantTopBarActions() {
  const html = renderTopBar();

  assert.match(html, />Current task</);
  assert.doesNotMatch(html, />Share</);
  assert.doesNotMatch(html, />Idle</);
  assert.doesNotMatch(html, />AA</);
  assert.doesNotMatch(html, /aria-label="Settings"/);
  assert.doesNotMatch(html, /aria-label="More options"/);
}

function testKeepsPendingApprovalSignal() {
  const html = renderTopBar({ pendingApprovalCount: 2 });

  assert.match(html, />2 approval</);
}

testOmitsRedundantTopBarActions();
testKeepsPendingApprovalSignal();

console.log("workbench top bar tests passed");
