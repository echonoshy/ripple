import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionPage from "./SessionPage";
import type { UsageInfo } from "@/types";

function noop() {}
async function noopAsync() {
  return {};
}

function renderSessionPage({
  tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  lastContextTokens = 0,
}: {
  tokenUsage?: UsageInfo;
  lastContextTokens?: number;
} = {}) {
  return renderToStaticMarkup(
    <SessionPage
      session={null}
      messages={[]}
      timelineEvents={[]}
      planProgress={null}
      planSteps={[]}
      tokenUsage={tokenUsage}
      lastContextTokens={lastContextTokens}
      input=""
      pendingFiles={[]}
      isGenerating={false}
      focusToken={0}
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      sessionId="srv-test"
      onNewSession={noop}
      onUpdateSessionSettings={noopAsync}
      onInputChange={noop}
      onClearContext={noop}
      onCompactContext={noop}
      onAttachFiles={noop}
      onRemovePendingFile={noop}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );
}

function renderSessionPageWithTimelineContent() {
  return renderToStaticMarkup(
    <SessionPage
      session={null}
      messages={[]}
      timelineEvents={[
        {
          id: "assistant-1",
          type: "assistant_message",
          title: "Update",
          body: "A wider timeline body should use the available session content width.",
        },
      ]}
      planProgress={null}
      planSteps={[]}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      lastContextTokens={0}
      input=""
      pendingFiles={[]}
      isGenerating={false}
      focusToken={0}
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      sessionId="srv-test"
      onNewSession={noop}
      onUpdateSessionSettings={noopAsync}
      onInputChange={noop}
      onClearContext={noop}
      onCompactContext={noop}
      onAttachFiles={noop}
      onRemovePendingFile={noop}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );
}

function testOmitsPlaceholderSessionHeaderControls() {
  const html = renderSessionPage();

  assert.match(html, /aria-label="Back to sessions"/);
  assert.match(html, /aria-label="New session"/);
  assert.match(html, /aria-label="Session options"/);
  assert.doesNotMatch(html, />New Codex task</);
  assert.doesNotMatch(html, /border-b border-\[#e5e7eb\] bg-white px-4 py-3 md:px-5/);
  assert.doesNotMatch(html, />Idle</);
  assert.doesNotMatch(html, /Codex keeps the task, files, activity, and approvals connected/);
  assert.doesNotMatch(html, /Ask Codex to refactor, debug, write, or inspect/);
  assert.doesNotMatch(html, />Timeline</);
  assert.doesNotMatch(html, />Diff</);
  assert.doesNotMatch(html, />Logs</);
  assert.doesNotMatch(html, />Checks</);
  assert.doesNotMatch(html, />main</);
  assert.doesNotMatch(html, /Task focus/);
  assert.doesNotMatch(html, /Refactor this app/);
  assert.doesNotMatch(html, /Analyze my files/);
  assert.doesNotMatch(html, /Draft a document/);
  assert.doesNotMatch(html, /sm:hidden[^>]*>Start here</);
  assert.doesNotMatch(html, /hidden sm:inline[^>]*>Workspace briefing</);
  assert.doesNotMatch(html, />Files</);
  assert.doesNotMatch(html, />Sessions</);
  assert.doesNotMatch(html, />Ask</);
  assert.doesNotMatch(html, />Tasks</);
  assert.doesNotMatch(html, /Review recent tasks/);
}

function testGivesSessionContentMoreHorizontalRoom() {
  const html = renderSessionPage();

  assert.match(html, /overflow-y-auto bg-transparent px-3 py-2 sm:px-4 sm:py-5 md:px-5/);
  assert.match(html, /mx-auto max-w-5xl space-y-2 sm:space-y-5/);
}

function testMobileHeaderReservesTopSafeArea() {
  const html = renderSessionPage();

  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),0px\)\]/);
}

function testTimelineTextUsesWiderContentWidth() {
  const html = renderSessionPageWithTimelineContent();

  assert.match(html, /markdown-body workbench-markdown max-w-4xl/);
}

function testContextWarningUsesReportedModelWindow() {
  const html = renderSessionPage({
    tokenUsage: {
      prompt_tokens: 76000,
      completion_tokens: 10,
      total_tokens: 76010,
      model_context_window: 100000,
    },
    lastContextTokens: 76000,
  });

  assert.match(html, /Context usage is around 76%/);
  assert.match(html, /76,000 \/ 100,000 tokens/);
  assert.match(html, /tokens in 76,000 \/ out 10/);
  assert.match(html, /context 76,000 \/ 100,000/);
}

function testContextWarningWaitsForModelWindow() {
  const html = renderSessionPage({
    tokenUsage: {
      prompt_tokens: 76000,
      completion_tokens: 10,
      total_tokens: 76010,
    },
    lastContextTokens: 76000,
  });

  assert.doesNotMatch(html, /Context usage is around/);
  assert.match(html, /context 76,000/);
  assert.doesNotMatch(html, /context 76,000 \/ 200,000/);
}

testOmitsPlaceholderSessionHeaderControls();
testGivesSessionContentMoreHorizontalRoom();
testMobileHeaderReservesTopSafeArea();
testTimelineTextUsesWiderContentWidth();
testContextWarningUsesReportedModelWindow();
testContextWarningWaitsForModelWindow();

console.log("session page tests passed");
