import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionPage from "./SessionPage";
import type { UsageInfo, WorkbenchSessionSummary } from "@/types";

const sessionPageSource = readFileSync(new URL("./SessionPage.tsx", import.meta.url), "utf8");

function noop() {}
async function noopAsync() {
  return {};
}

function sessionAutoScrollEffectSource() {
  const match = sessionPageSource.match(
    /useLayoutEffect\(\(\) => \{[\s\S]*?previousAutoScrollSessionIdRef[\s\S]*?\}, \[[\s\S]*?\]\);/
  );
  return match?.[0] || "";
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
      pendingLocalImages={[]}
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
      onAddPendingImages={noop}
      onRemovePendingLocalImage={noop}
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
      pendingLocalImages={[]}
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
      onAddPendingImages={noop}
      onRemovePendingLocalImage={noop}
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

function testMobileHeaderButtonsUseToolbarStyling() {
  const html = renderSessionPage();
  const backButton = html.match(
    /<button[^>]*aria-label="Back to sessions"[^>]*>[\s\S]*?<\/button>/
  )?.[0];

  assert.ok(backButton);
  assert.match(backButton, /lucide-chevron-left/);
  assert.match(backButton, /<path d="m15 18-6-6 6-6"><\/path>/);
  assert.doesNotMatch(backButton, /lucide-arrow-big-left/);
  assert.match(
    sessionPageSource,
    /mobileHeaderButtonClass =\s+"inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white\/70 bg-white\/68 text-\[#516070\]/
  );
  assert.match(sessionPageSource, /ChevronLeft/);
  assert.match(sessionPageSource, /MessageCircleMore/);
  assert.match(sessionPageSource, /Ellipsis/);
  assert.doesNotMatch(sessionPageSource, /mobileHeaderPrimaryButtonClass/);
  assert.doesNotMatch(sessionPageSource, /SquareChevronLeft/);
  assert.doesNotMatch(sessionPageSource, /ArrowBigLeftDash/);
  assert.doesNotMatch(sessionPageSource, /<ArrowLeft size=\{22\}/);
  assert.doesNotMatch(sessionPageSource, /<MessageSquarePlus size=\{18\}/);
  assert.doesNotMatch(sessionPageSource, /<Plus size=\{21\}/);
  assert.doesNotMatch(sessionPageSource, /<SquarePen size=\{18\}/);
  assert.doesNotMatch(sessionPageSource, /<MoreHorizontal size=\{22\}/);
  assert.doesNotMatch(sessionPageSource, /<Settings2 size=\{18\}/);
  assert.doesNotMatch(
    sessionPageSource,
    /className="inline-flex h-10 w-10 items-center justify-center rounded-full text-\[#172033\] active:bg-\[#eef3ff\]/
  );
}

function testSessionSettingsUsesGroupedFormPanel() {
  assert.match(sessionPageSource, /data-ripple-session-settings-body="grouped-form"/);
  assert.match(sessionPageSource, /data-ripple-session-settings-group="name"/);
  assert.match(sessionPageSource, /data-ripple-session-settings-group="pinned"/);
  assert.match(sessionPageSource, /Keep this session near the top/);
  assert.match(sessionPageSource, /aria-hidden="true"[\s\S]*settingsPinned/);
  assert.match(sessionPageSource, /type="button"[\s\S]*>\s*Cancel\s*<\/button>/);
  assert.match(sessionPageSource, /type="submit"[\s\S]*Save\s*<\/button>/);
  assert.doesNotMatch(sessionPageSource, /space-y-5 overflow-y-auto px-4 py-4/);
  assert.doesNotMatch(sessionPageSource, /rounded-full border px-4 text-left text-\[14px\] font-medium/);
  assert.doesNotMatch(sessionPageSource, /linear-gradient\(135deg,#2f6bff,#7b5cff\)/);
}

function testGivesSessionContentMoreHorizontalRoom() {
  const html = renderSessionPage();

  assert.match(html, /overflow-y-auto bg-transparent px-3 py-2 sm:px-4 sm:py-5 md:px-5/);
  assert.match(html, /mx-auto max-w-5xl space-y-2 sm:space-y-5/);
}

function testSessionPageHandlesDropAcrossWholeChat() {
  assert.match(sessionPageSource, /onDrop=\{handlePageDrop\}/);
  assert.match(sessionPageSource, /filesFromDropData/);
  assert.match(sessionPageSource, /partitionTransferFiles/);
  assert.match(sessionPageSource, /onAddPendingImages\(images, "drop"\)/);
  assert.match(sessionPageSource, /void onAttachFiles\(attachmentFiles\)/);
}

function testMobileHeaderReservesTopSafeArea() {
  const html = renderSessionPage();

  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),0px\)\]/);
}

function testDesktopHeaderShowsCurrentModelLikeMobile() {
  const html = renderSessionPage();

  assert.match(html, /lg:flex/);
  assert.match(html, /aria-label="Current model: Plus"/);
  assert.match(html, /title="Current model: Plus"/);
}

function testSessionPageShowsCurrentFolderBadge() {
  const folderSession: WorkbenchSessionSummary = {
    sessionId: "srv-demo",
    title: "Folder session",
    pinned: false,
    status: "idle",
    model: "codex-medium",
    lastActivityAt: "2026-05-30T00:00:00Z",
    messageCount: 0,
    changedFileCount: 0,
    pendingApprovalCount: 0,
    projectId: null,
    projectName: null,
    projectRoot: null,
    contextFolderPath: "/workspace/demo",
  };
  const html = renderToStaticMarkup(
    <SessionPage
      session={folderSession}
      messages={[]}
      timelineEvents={[]}
      planProgress={null}
      planSteps={[]}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      lastContextTokens={0}
      input=""
      pendingFiles={[]}
      pendingLocalImages={[]}
      isGenerating={false}
      focusToken={0}
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      sessionId="srv-demo"
      onNewSession={noop}
      onUpdateSessionSettings={noopAsync}
      onInputChange={noop}
      onClearContext={noop}
      onCompactContext={noop}
      onAttachFiles={noop}
      onRemovePendingFile={noop}
      onAddPendingImages={noop}
      onRemovePendingLocalImage={noop}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );

  assert.match(html, /Folder: demo/);
  assert.match(html, /title="\/workspace\/demo"/);
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
  assert.match(html, /Tokens 76k in \/ 10 out \u00b7 Ctx 76k \/ 100k \(76%\)/);
  assert.match(html, /aria-label="Tokens in 76,000, out 10\. Context 76,000 \/ 100,000\."/);
  assert.match(html, /title="Tokens in 76,000, out 10\. Context 76,000 \/ 100,000\."/);
  assert.match(html, /italic/);
  assert.match(html, /bg-white\/60/);
  assert.doesNotMatch(html, /tokens in 76,000 \/ out 10/);
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
  assert.match(html, /Tokens 76k in \/ 10 out \u00b7 Ctx 76k/);
  assert.match(html, /aria-label="Tokens in 76,000, out 10\. Context 76,000\."/);
  assert.doesNotMatch(html, /context 76,000 \/ 200,000/);
}

function testTokenBadgeOmitsContextWhenUnavailable() {
  const html = renderSessionPage({
    tokenUsage: {
      prompt_tokens: 20742,
      completion_tokens: 663,
      total_tokens: 21405,
    },
    lastContextTokens: 0,
  });

  assert.match(html, /Tokens 20\.7k in \/ 663 out/);
  assert.match(html, /aria-label="Tokens in 20,742, out 663\."/);
  assert.doesNotMatch(html, /Ctx/);
}

function testSessionSwitchScrollsToBottomWithoutSmoothAnimation() {
  const sessionSwitchEffect = sessionAutoScrollEffectSource();

  assert.match(sessionSwitchEffect, /sessionChanged/);
  assert.match(sessionPageSource, /scrollContainer\.scrollTop = scrollContainer\.scrollHeight/);
  assert.doesNotMatch(sessionPageSource, /scrollIntoView/);
  assert.doesNotMatch(sessionPageSource, /bottomAnchorRef/);
  assert.doesNotMatch(sessionPageSource, /scrollActivationKey/);
}

function testAutoScrollEffectUsesStableTimelineKey() {
  const contentChangeEffect =
    sessionPageSource.match(
      /useLayoutEffect\(\(\) => \{\s*if \(!shouldKeepStickingToBottom\(\)\) return;\s*scrollToBottom\(\);\s*\}, \[([\s\S]*?)\]\);/
    )?.[0] || "";
  const dependencies = contentChangeEffect.match(/\}, \[([\s\S]*?)\]\);/)?.[1] || "";

  assert.match(sessionPageSource, /lastTimelineEventId/);
  assert.match(dependencies, /lastTimelineEventId/);
  assert.doesNotMatch(dependencies, /\btimelineEvents\b/);
}

function testResizeObserverKeepsSessionSwitchPinnedToBottom() {
  assert.match(sessionPageSource, /STICK_TO_BOTTOM_MS/);
  assert.match(sessionPageSource, /stickToBottomUntilRef/);
  assert.match(sessionPageSource, /new ResizeObserver/);
  assert.match(sessionPageSource, /observer\.observe\(content\)/);
  assert.match(sessionPageSource, /shouldKeepStickingToBottom/);
}

function testUserScrollCancelsSessionSwitchStickyBottom() {
  assert.match(sessionPageSource, /BOTTOM_LOCK_THRESHOLD_PX/);
  assert.match(sessionPageSource, /const handleScroll/);
  assert.match(sessionPageSource, /distanceFromBottom > BOTTOM_LOCK_THRESHOLD_PX/);
  assert.match(sessionPageSource, /stickToBottomUntilRef\.current = 0/);
  assert.match(sessionPageSource, /onScroll=\{handleScroll\}/);
  assert.match(sessionPageSource, /ref=\{contentRef\}/);
}

function testSessionPageOwnsScrollActivation() {
  assert.doesNotMatch(sessionPageSource, /scrollActivationKey/);
}

function testExplicitSessionSelectionTriggersStickyBottom() {
  assert.match(sessionPageSource, /scrollToBottomRequest\?: number/);
  assert.match(sessionPageSource, /previousScrollToBottomRequestRef/);
  assert.match(sessionPageSource, /requestChanged/);
  assert.match(sessionPageSource, /startStickToBottom\(\)/);
}

function testSessionPageCanRestorePreviousScrollPosition() {
  assert.match(sessionPageSource, /restoreScrollTop\?: number \| null/);
  assert.match(sessionPageSource, /onRestoreScrollComplete\?: \(\) => void/);
  assert.match(sessionPageSource, /data-ripple-session-scroll="timeline"/);
  assert.match(sessionPageSource, /scrollContainer\.scrollTop = restoreScrollTop/);
  assert.match(sessionPageSource, /onRestoreScrollComplete\?\.\(\)/);
}

testOmitsPlaceholderSessionHeaderControls();
testMobileHeaderButtonsUseToolbarStyling();
testSessionSettingsUsesGroupedFormPanel();
testGivesSessionContentMoreHorizontalRoom();
testSessionPageHandlesDropAcrossWholeChat();
testMobileHeaderReservesTopSafeArea();
testDesktopHeaderShowsCurrentModelLikeMobile();
testSessionPageShowsCurrentFolderBadge();
testTimelineTextUsesWiderContentWidth();
testContextWarningUsesReportedModelWindow();
testContextWarningWaitsForModelWindow();
testTokenBadgeOmitsContextWhenUnavailable();
testSessionSwitchScrollsToBottomWithoutSmoothAnimation();
testAutoScrollEffectUsesStableTimelineKey();
testResizeObserverKeepsSessionSwitchPinnedToBottom();
testUserScrollCancelsSessionSwitchStickyBottom();
testSessionPageOwnsScrollActivation();
testExplicitSessionSelectionTriggersStickyBottom();
testSessionPageCanRestorePreviousScrollPosition();

console.log("session page tests passed");
