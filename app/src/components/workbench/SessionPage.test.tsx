import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import SessionPage, {
  composerFocusedRestoreScrollTop,
  getVisualViewportKeyboardInset,
  reservedMobileComposerHeight,
  sessionTimelineBottomScrollTop,
  shouldRevealTokenFooterOnUsageChange,
  shouldShowTokenFooter,
  shouldSuppressTimelineAutoScroll,
} from "./SessionPage";
import type { Message, UsageInfo, WorkbenchSessionSummary } from "@/types";

const sessionPageSource = readFileSync(new URL("./SessionPage.tsx", import.meta.url), "utf8");

function noop() {}

function sessionAutoScrollEffectSource() {
  const match = sessionPageSource.match(
    /useLayoutEffect\(\(\) => \{[\s\S]*?previousAutoScrollSessionIdRef[\s\S]*?\}, \[[\s\S]*?\]\);/
  );
  return match?.[0] || "";
}

function renderSessionPage({
  tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  lastContextTokens = 0,
  messages = [],
  session = null,
  isSessionLoading = false,
  isGenerating = false,
  selectedModel = "codex-medium",
  models = [{ id: "codex-medium", owned_by: "ripple" }],
  locale = "en-US",
}: {
  tokenUsage?: UsageInfo;
  lastContextTokens?: number;
  messages?: Message[];
  session?: WorkbenchSessionSummary | null;
  isSessionLoading?: boolean;
  isGenerating?: boolean;
  selectedModel?: string;
  models?: { id: string; owned_by: string }[];
  locale?: LocalePreference;
} = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <SessionPage
        session={session}
        messages={messages}
        timelineEvents={[]}
        planProgress={null}
        planSteps={[]}
        tokenUsage={tokenUsage}
        lastContextTokens={lastContextTokens}
        input=""
        pendingFiles={[]}
        pendingLocalImages={[]}
        isGenerating={isGenerating}
        focusToken={0}
        selectedModel={selectedModel}
        models={models}
        isModelDropdownOpen={false}
        isSessionLoading={isSessionLoading}
        sessionId="srv-test"
        onNewSession={noop}
        onInputChange={noop}
        onAttachFiles={noop}
        onRemovePendingFile={noop}
        onAddPendingImages={noop}
        onRemovePendingLocalImage={noop}
        onToggleModelDropdown={noop}
        onCloseModelDropdown={noop}
        onSelectModel={noop}
        onSend={noop}
        onStop={noop}
        onQuickReply={noop}
        onPermissionResolve={noop}
      />
    </I18nProvider>
  );
}

function renderSessionPageWithTimelineContent() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
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
        onInputChange={noop}
        onAttachFiles={noop}
        onRemovePendingFile={noop}
        onAddPendingImages={noop}
        onRemovePendingLocalImage={noop}
        onToggleModelDropdown={noop}
        onCloseModelDropdown={noop}
        onSelectModel={noop}
        onSend={noop}
        onStop={noop}
        onQuickReply={noop}
        onPermissionResolve={noop}
      />
    </I18nProvider>
  );
}

function testOmitsPlaceholderSessionHeaderControls() {
  const html = renderSessionPage();

  assert.match(html, /aria-label="Back to sessions"/);
  assert.match(html, /aria-label="New session"/);
  assert.doesNotMatch(html, /aria-label="Session options"/);
  assert.doesNotMatch(html, />New Codex task</);
  assert.doesNotMatch(html, /border-b border-\[#EFF0F1\] bg-white px-4 py-3 md:px-5/);
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
  assert.match(backButton, /rounded-xl/);
  assert.doesNotMatch(backButton, /border-\[#DEE0E3\]/);
  assert.doesNotMatch(backButton, /bg-white/);
  assert.match(backButton, /bg-transparent/);
  assert.doesNotMatch(backButton, /backdrop-blur-xl/);
  assert.match(sessionPageSource, /mobileChatHeaderButtonClass/);
  assert.doesNotMatch(sessionPageSource, /const mobileHeaderButtonClass = WORKBENCH_MOBILE_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(sessionPageSource, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(sessionPageSource, /ChevronLeft/);
  assert.match(sessionPageSource, /MessageCircleMore/);
  assert.match(sessionPageSource, /grid-cols-\[44px_minmax\(0,1fr\)_44px\]/);
  assert.match(sessionPageSource, /max-w-\[56vw\]/);
  assert.doesNotMatch(sessionPageSource, /max-w-\[48vw\]/);
  assert.doesNotMatch(sessionPageSource, /Ellipsis/);
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
    /className="inline-flex h-10 w-10 items-center justify-center rounded-full text-\[#1F2329\] active:bg-\[#F0F5FF\]/
  );
}

function testSessionPageUsesSharedWorkbenchBackground() {
  assert.match(sessionPageSource, /WORKBENCH_PAGE_BACKGROUND_CLASS/);
  assert.doesNotMatch(sessionPageSource, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.doesNotMatch(sessionPageSource, /circle_at_18%_0%/);
}

function testSessionPageOmitsSecondarySettingsSheet() {
  assert.doesNotMatch(sessionPageSource, /onUpdateSessionSettings/);
  assert.doesNotMatch(sessionPageSource, /isSessionSettingsOpen/);
  assert.doesNotMatch(sessionPageSource, /openSessionSettings/);
  assert.doesNotMatch(sessionPageSource, /data-ripple-session-settings-body/);
  assert.doesNotMatch(sessionPageSource, /data-ripple-session-settings-group/);
  assert.doesNotMatch(sessionPageSource, /settingsPinned/);
  assert.doesNotMatch(sessionPageSource, /space-y-5 overflow-y-auto px-4 py-4/);
  assert.doesNotMatch(
    sessionPageSource,
    /rounded-full border px-4 text-left text-\[14px\] font-medium/
  );
  assert.doesNotMatch(sessionPageSource, /bg-\[linear-gradient\(135deg/);
}

function testGivesSessionContentMoreHorizontalRoom() {
  const html = renderSessionPage();

  assert.match(html, /overflow-y-auto bg-white px-3/);
  assert.doesNotMatch(html, /overflow-y-auto bg-white\/92/);
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

function testMobileHeaderIsOverlayChrome() {
  const html = renderSessionPage();
  const header = html.match(/<div[^>]*data-ripple-mobile-chat-header="true"[^>]*>/)?.[0] || "";

  assert.match(html, /data-ripple-mobile-chat-header="true"/);
  assert.match(html, /absolute inset-x-0 top-0 z-30/);
  assert.match(html, /translate-y-0/);
  assert.doesNotMatch(html, /data-ripple-mobile-chat-header-hidden=/);
  assert.doesNotMatch(html, /-translate-y-full/);
  assert.match(header, /bg-white/);
  assert.doesNotMatch(header, /bg-white\/76/);
  assert.doesNotMatch(header, /backdrop-blur-2xl/);
}

function testDesktopHeaderShowsCurrentModelLikeMobile() {
  const html = renderSessionPage();

  assert.match(html, /lg:flex/);
  assert.match(html, /aria-label="Current model: Plus"/);
  assert.match(html, /title="Current model: Plus"/);
}

function testMobileHeaderModelBadgeIsStaticDisplay() {
  const html = renderSessionPage({
    selectedModel: "codex-medium",
    models: [
      { id: "codex-low", owned_by: "ripple" },
      { id: "codex-medium", owned_by: "ripple" },
      { id: "codex-high", owned_by: "ripple" },
    ],
  });
  const headerBadge =
    html.match(/<span[^>]*data-ripple-current-model-badge="mobile"[\s\S]*?<\/span>/)?.[0] ||
    "";

  assert.match(headerBadge, /aria-label="Current model: Plus"/);
  assert.match(headerBadge, /title="Current model: Plus"/);
  assert.match(headerBadge, /lucide-brain-circuit/);
  assert.doesNotMatch(html, /data-ripple-mobile-model-button="true"/);
  assert.doesNotMatch(html, /data-ripple-mobile-model-menu="true"/);
  assert.doesNotMatch(html, /role="menu"/);
  assert.doesNotMatch(sessionPageSource, /onToggleMobileHeaderModelDropdown/);
  assert.doesNotMatch(sessionPageSource, /isMobileHeaderModelDropdownOpen/);
}

function testCurrentModelBadgeUsesModelSwitchIcon() {
  const html = renderSessionPage();

  assert.match(html, /data-ripple-current-model-badge="desktop"[\s\S]{0,1000}lucide-brain-circuit/);
  assert.match(html, /data-ripple-current-model-badge="desktop"[\s\S]{0,1200}bg-\[#22A06B\]/);
  assert.match(html, /data-ripple-current-model-badge="mobile"[\s\S]{0,1000}lucide-brain-circuit/);
  assert.match(html, /data-ripple-current-model-badge="mobile"[\s\S]{0,1800}bg-\[#22A06B\]/);
}

function testMobileRunStatusOnlyLivesInHeaderAndComposer() {
  const runningSession: WorkbenchSessionSummary = {
    sessionId: "srv-running",
    title: "Running session",
    pinned: false,
    status: "running",
    model: "codex-medium",
    lastActivityAt: "2026-06-08T00:00:00Z",
    messageCount: 1,
    changedFileCount: 0,
    pendingApprovalCount: 0,
  };
  const html = renderSessionPage({ session: runningSession, isGenerating: true });

  assert.doesNotMatch(html, /data-ripple-mobile-run-status-bar="true"/);
  assert.doesNotMatch(html, /data-ripple-mobile-run-status="running"/);
  assert.doesNotMatch(
    html,
    /sticky top-\[calc\(var\(--ripple-mobile-chat-header-height\)\+8px\)\]/
  );
  assert.doesNotMatch(sessionPageSource, /mobileRunStatusBarHeight/);
  assert.doesNotMatch(sessionPageSource, /--ripple-mobile-run-status-height/);
  assert.match(html, />Working.../);
  assert.match(html, /Plus/);
}

function testSessionPageRendersChineseStaticChrome() {
  const html = renderSessionPage({ locale: "zh-CN" });

  assert.match(html, /aria-label="返回会话"/);
  assert.match(html, /aria-label="新会话"/);
  assert.doesNotMatch(html, /aria-label="会话选项"/);
  assert.match(html, />会话</);
  assert.match(html, /aria-label="当前模型：Plus"/);
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
    <I18nProvider initialPreference="en-US">
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
        onInputChange={noop}
        onAttachFiles={noop}
        onRemovePendingFile={noop}
        onAddPendingImages={noop}
        onRemovePendingLocalImage={noop}
        onToggleModelDropdown={noop}
        onCloseModelDropdown={noop}
        onSelectModel={noop}
        onSend={noop}
        onStop={noop}
        onQuickReply={noop}
        onPermissionResolve={noop}
      />
    </I18nProvider>
  );

  assert.match(html, /aria-label="Current model: Plus"/);
  assert.match(html, /aria-label="Work folder: demo"/);
  assert.match(html, /lucide-folder/);
  assert.doesNotMatch(html, /Plus Focus: demo/);
  assert.doesNotMatch(html, /Focus folder/);
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
  assert.match(html, /bg-\[#F8F9FA\]/);
  assert.doesNotMatch(html, /bg-white\/60/);
  assert.doesNotMatch(html, /backdrop-blur-xl/);
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

function testTokenBadgeHidesPreviousUsageWhileGenerating() {
  const html = renderSessionPage({
    tokenUsage: {
      prompt_tokens: 1200,
      completion_tokens: 93,
      total_tokens: 1293,
    },
    isGenerating: true,
  });

  assert.doesNotMatch(html, /Tokens 1\.2k in \/ 93 out/);
  assert.doesNotMatch(html, /aria-label="Tokens in 1,200, out 93\."/);
}

function testTokenBadgeUsesCompactRectangleRadius() {
  const html = renderSessionPage({
    tokenUsage: {
      prompt_tokens: 1200,
      completion_tokens: 93,
      total_tokens: 1293,
    },
  });
  const tokenBadge =
    html.match(/<span[^>]*aria-label="Tokens in 1,200, out 93\."[^>]*>/)?.[0] || "";

  assert.match(tokenBadge, /rounded-lg/);
  assert.doesNotMatch(tokenBadge, /rounded-full/);
}

function testSessionSwitchScrollsToBottomWithoutSmoothAnimation() {
  const sessionSwitchEffect = sessionAutoScrollEffectSource();

  assert.match(sessionSwitchEffect, /sessionChanged/);
  assert.match(sessionPageSource, /sessionTimelineBottomScrollTop/);
  assert.match(sessionPageSource, /scrollContainer\.scrollTop = nextScrollTop/);
  assert.doesNotMatch(sessionPageSource, /scrollIntoView/);
  assert.doesNotMatch(sessionPageSource, /bottomAnchorRef/);
  assert.doesNotMatch(sessionPageSource, /scrollActivationKey/);
}

function testShortTimelineDoesNotWriteScrollTop() {
  assert.equal(
    sessionTimelineBottomScrollTop({
      scrollHeight: 320,
      clientHeight: 480,
    }),
    null
  );
  assert.equal(
    sessionTimelineBottomScrollTop({
      scrollHeight: 480,
      clientHeight: 480,
    }),
    null
  );
  assert.equal(
    sessionTimelineBottomScrollTop({
      scrollHeight: 960,
      clientHeight: 480,
    }),
    480
  );
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

function testGeneratingFlagUpdatesBeforeAutoScrollLayoutEffect() {
  const generatingRefEffectIndex = sessionPageSource.indexOf(
    "useLayoutEffect(() => {\n    isGeneratingRef.current = isGenerating;"
  );
  const autoScrollEffectIndex = sessionPageSource.indexOf(
    "useLayoutEffect(() => {\n    if (!shouldKeepStickingToBottom()) return;"
  );

  assert.notEqual(generatingRefEffectIndex, -1);
  assert.notEqual(autoScrollEffectIndex, -1);
  assert.ok(generatingRefEffectIndex < autoScrollEffectIndex);
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

function testMobileHeaderStaysVisibleWhileScrolling() {
  assert.doesNotMatch(sessionPageSource, /isMobileHeaderHidden/);
  assert.doesNotMatch(sessionPageSource, /setIsMobileHeaderHidden/);
  assert.doesNotMatch(sessionPageSource, /updateMobileHeaderVisibility/);
  assert.doesNotMatch(sessionPageSource, /shouldHideMobileChatHeaderOnScroll/);
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

function testComposerSendStartsStickyBottomBeforeSending() {
  const handleComposerSendBlock =
    sessionPageSource.match(
      /const handleComposerSend = useCallback\(\(\) => \{[\s\S]*?\}, \[[^\]]+\]\);/
    )?.[0] || "";

  assert.match(handleComposerSendBlock, /startStickToBottom\(\);[\s\S]*onSend\(\);/);
  assert.match(sessionPageSource, /onSend=\{handleComposerSend\}/);
}

function testSessionPageCanRestorePreviousScrollPosition() {
  assert.match(sessionPageSource, /restoreScrollTop\?: number \| null/);
  assert.match(sessionPageSource, /onRestoreScrollComplete\?: \(\) => void/);
  assert.match(sessionPageSource, /data-ripple-session-scroll="timeline"/);
  assert.match(sessionPageSource, /scrollContainer\.scrollTop = restoreScrollTop/);
  assert.match(sessionPageSource, /onRestoreScrollComplete\?\.\(\)/);
}

function testTimelineScrollContainerAllowsHorizontalSwipeBackInTouchEmulation() {
  const timelineBlock =
    sessionPageSource.match(
      /<div\s+ref=\{scrollContainerRef\}[\s\S]*?data-ripple-session-scroll="timeline"[\s\S]*?>/
    )?.[0] || "";

  assert.match(timelineBlock, /overflow-y-auto/);
  assert.match(timelineBlock, /touch-pan-y/);
}

function testVisualViewportKeyboardInsetUsesLayoutViewportBottomGap() {
  assert.equal(
    getVisualViewportKeyboardInset({
      innerHeight: 800,
      visualViewport: { height: 520, offsetTop: 0 },
    }),
    280
  );
  assert.equal(
    getVisualViewportKeyboardInset({
      innerHeight: 800,
      visualViewport: { height: 780, offsetTop: 20 },
    }),
    0
  );
  assert.equal(getVisualViewportKeyboardInset({ innerHeight: 800 }), 0);
}

function testSessionPageNoLongerOwnsMobileBackSwipeGesture() {
  assert.match(sessionPageSource, /data-ripple-mobile-chat-surface/);
  assert.doesNotMatch(sessionPageSource, /shouldTriggerMobileSessionBackSwipe/);
  assert.doesNotMatch(sessionPageSource, /MOBILE_CHAT_SWIPE_EDGE_PX/);
  assert.doesNotMatch(sessionPageSource, /handleMobileChatPointerDown/);
  assert.doesNotMatch(sessionPageSource, /onPointerMove=\{handleMobileChatPointerMove\}/);
}

function testComposerFocusSuppressesTimelineAutoScroll() {
  assert.match(sessionPageSource, /isComposerFocusedRef/);
  assert.match(sessionPageSource, /shouldSuppressTimelineAutoScroll/);
  assert.match(sessionPageSource, /handleComposerFocusStateChange/);
  assert.match(sessionPageSource, /onFocusStateChange=\{handleComposerFocusStateChange\}/);
}

function testComposerFocusDoesNotSuppressRunAutoScroll() {
  assert.equal(
    shouldSuppressTimelineAutoScroll({
      isComposerFocused: true,
      isGenerating: true,
      isWithinStickyBottomWindow: false,
    }),
    false
  );
  assert.equal(
    shouldSuppressTimelineAutoScroll({
      isComposerFocused: true,
      isGenerating: false,
      isWithinStickyBottomWindow: true,
    }),
    false
  );
  assert.equal(
    shouldSuppressTimelineAutoScroll({
      isComposerFocused: true,
      isGenerating: false,
      isWithinStickyBottomWindow: false,
    }),
    true
  );
}

function testComposerFocusDoesNotTrackKeyboardMovedScrollTop() {
  const handleScrollBlock =
    sessionPageSource.match(
      /const handleScroll = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/
    )?.[0] || "";

  assert.doesNotMatch(handleScrollBlock, /updateMobileHeaderVisibility/);
  assert.doesNotMatch(
    handleScrollBlock,
    /composerFocusedScrollTopRef\.current = scrollContainer\.scrollTop/
  );
}

function testComposerFocusRestoreAccountsForExpandedComposerHeight() {
  assert.equal(
    composerFocusedRestoreScrollTop({
      focusedScrollTop: 620,
      focusedComposerHeight: 96,
      currentComposerHeight: 220,
      scrollHeight: 1600,
      clientHeight: 720,
    }),
    744
  );
  assert.equal(
    composerFocusedRestoreScrollTop({
      focusedScrollTop: 930,
      focusedComposerHeight: 96,
      currentComposerHeight: 260,
      scrollHeight: 1600,
      clientHeight: 720,
    }),
    880
  );
  assert.equal(
    composerFocusedRestoreScrollTop({
      focusedScrollTop: 24,
      focusedComposerHeight: 180,
      currentComposerHeight: 96,
      scrollHeight: 1600,
      clientHeight: 720,
    }),
    0
  );
}

function testTokenUsageIncreaseRevealsFooter() {
  assert.equal(
    shouldRevealTokenFooterOnUsageChange({
      previousTotalTokens: 0,
      nextTotalTokens: 1200,
    }),
    true
  );
  assert.equal(
    shouldRevealTokenFooterOnUsageChange({
      previousTotalTokens: 1200,
      nextTotalTokens: 1200,
    }),
    false
  );
  assert.equal(
    shouldRevealTokenFooterOnUsageChange({
      previousTotalTokens: 1200,
      nextTotalTokens: 300,
    }),
    false
  );
  assert.equal(
    shouldRevealTokenFooterOnUsageChange({
      previousTotalTokens: 1200,
      nextTotalTokens: 1200,
      previousVisible: false,
      nextVisible: true,
    }),
    true
  );

  assert.match(sessionPageSource, /previousTokenUsageTotalRef/);
  assert.match(sessionPageSource, /previousTokenFooterVisibleRef/);
  assert.match(sessionPageSource, /scrollToBottom\(\{ force: true \}\)/);
}

function testTokenFooterOnlyShowsAfterGenerationSettles() {
  assert.equal(
    shouldShowTokenFooter({
      isGenerating: true,
      isSessionLoading: false,
      totalTokens: 1200,
    }),
    false
  );
  assert.equal(
    shouldShowTokenFooter({
      isGenerating: false,
      isSessionLoading: false,
      totalTokens: 1200,
    }),
    true
  );
  assert.equal(
    shouldShowTokenFooter({
      isGenerating: false,
      isSessionLoading: true,
      totalTokens: 1200,
    }),
    false
  );
}

function testMobileComposerReserveUsesMeasuredHeight() {
  assert.equal(
    reservedMobileComposerHeight({
      measuredHeight: 92,
    }),
    92
  );
  assert.equal(
    reservedMobileComposerHeight({
      measuredHeight: 260,
    }),
    260
  );

  assert.match(sessionPageSource, /mobileComposerReservedHeight/);
  assert.doesNotMatch(sessionPageSource, /MOBILE_CHAT_COMPOSER_EXPANDED_FALLBACK_HEIGHT_PX/);
  assert.doesNotMatch(sessionPageSource, /isMobileComposerExpanded/);
  assert.match(
    sessionPageSource,
    /"--ripple-mobile-chat-composer-height": `\$\{mobileComposerReservedHeight/
  );
}

function testMobileOverlayMeasurementsUseBorderBoxHeight() {
  assert.match(sessionPageSource, /function elementBorderBoxHeight/);
  assert.match(sessionPageSource, /element\.getBoundingClientRect\(\)\.height/);
  assert.match(sessionPageSource, /elementBorderBoxHeight\(entry\.target\)/);
  assert.match(sessionPageSource, /elementBorderBoxHeight\(node\)/);
  assert.doesNotMatch(sessionPageSource, /entry\.contentRect\.height/);
}

function testMobileTimelinePadsForOverlayHeaderAndComposer() {
  const html = renderSessionPage();

  assert.match(html, /--ripple-mobile-chat-header-height:/);
  assert.match(html, /--ripple-mobile-chat-composer-height:/);
  assert.match(html, /--ripple-mobile-chat-composer-gap:/);
  assert.match(html, /--ripple-mobile-keyboard-inset:/);
  assert.match(html, /pt-\[calc\(var\(--ripple-mobile-chat-header-height\)\+8px\)\]/);
  assert.match(
    html,
    /pb-\[calc\(var\(--ripple-mobile-chat-composer-height\)\+var\(--ripple-mobile-chat-composer-gap\)\)\]/
  );
  assert.doesNotMatch(
    html,
    /pb-\[calc\(var\(--ripple-mobile-chat-composer-height\)\+var\(--ripple-mobile-keyboard-inset\)/
  );
  assert.match(sessionPageSource, /translate3d\(0, -\$\{mobileKeyboardInset\}px, 0\)/);
}

function testPendingSessionDetailsShowSkeletonInsteadOfPreviousMessages() {
  const loadingSession: WorkbenchSessionSummary = {
    sessionId: "srv-next",
    title: "Next mobile session",
    pinned: false,
    status: "idle",
    model: "codex-medium",
    lastActivityAt: "2026-06-05T00:00:00Z",
    messageCount: 12,
    changedFileCount: 0,
    pendingApprovalCount: 0,
  };
  const html = renderSessionPage({
    session: loadingSession,
    isSessionLoading: true,
    messages: [{ id: "old-message", role: "user", content: "old session should not flash" }],
  });

  assert.match(html, />Next mobile session</);
  assert.match(html, /data-ripple-session-loading-skeleton="true"/);
  assert.match(html, /data-ripple-mobile-composer-overlay-loading="true"/);
  assert.doesNotMatch(html, /old session should not flash/);
  assert.match(sessionPageSource, /isSessionLoading\?: boolean/);
}

function testMobileChatStatusUsesStaticGenerationIndicators() {
  assert.doesNotMatch(sessionPageSource, /animate-pulse/);
  assert.match(sessionPageSource, /isGenerating\s*\?\s*"shrink-0 text-\[#1456F0\]"/);
  assert.match(sessionPageSource, /isGenerating\s*\?\s*"bg-\[#1456F0\]"\s*:\s*"bg-\[#22A06B\]"/);
}

testOmitsPlaceholderSessionHeaderControls();
testMobileHeaderButtonsUseToolbarStyling();
testSessionPageUsesSharedWorkbenchBackground();
testSessionPageOmitsSecondarySettingsSheet();
testGivesSessionContentMoreHorizontalRoom();
testSessionPageHandlesDropAcrossWholeChat();
testMobileHeaderReservesTopSafeArea();
testMobileHeaderIsOverlayChrome();
testDesktopHeaderShowsCurrentModelLikeMobile();
testMobileHeaderModelBadgeIsStaticDisplay();
testCurrentModelBadgeUsesModelSwitchIcon();
testMobileRunStatusOnlyLivesInHeaderAndComposer();
testSessionPageRendersChineseStaticChrome();
testSessionPageShowsCurrentFolderBadge();
testTimelineTextUsesWiderContentWidth();
testContextWarningUsesReportedModelWindow();
testContextWarningWaitsForModelWindow();
testTokenBadgeOmitsContextWhenUnavailable();
testTokenBadgeHidesPreviousUsageWhileGenerating();
testTokenBadgeUsesCompactRectangleRadius();
testSessionSwitchScrollsToBottomWithoutSmoothAnimation();
testShortTimelineDoesNotWriteScrollTop();
testAutoScrollEffectUsesStableTimelineKey();
testGeneratingFlagUpdatesBeforeAutoScrollLayoutEffect();
testResizeObserverKeepsSessionSwitchPinnedToBottom();
testUserScrollCancelsSessionSwitchStickyBottom();
testMobileHeaderStaysVisibleWhileScrolling();
testSessionPageOwnsScrollActivation();
testExplicitSessionSelectionTriggersStickyBottom();
testComposerSendStartsStickyBottomBeforeSending();
testSessionPageCanRestorePreviousScrollPosition();
testTimelineScrollContainerAllowsHorizontalSwipeBackInTouchEmulation();
testVisualViewportKeyboardInsetUsesLayoutViewportBottomGap();
testSessionPageNoLongerOwnsMobileBackSwipeGesture();
testComposerFocusSuppressesTimelineAutoScroll();
testComposerFocusDoesNotSuppressRunAutoScroll();
testComposerFocusDoesNotTrackKeyboardMovedScrollTop();
testComposerFocusRestoreAccountsForExpandedComposerHeight();
testTokenUsageIncreaseRevealsFooter();
testTokenFooterOnlyShowsAfterGenerationSettles();
testMobileComposerReserveUsesMeasuredHeight();
testMobileOverlayMeasurementsUseBorderBoxHeight();
testMobileTimelinePadsForOverlayHeaderAndComposer();
testPendingSessionDetailsShowSkeletonInsteadOfPreviousMessages();
testMobileChatStatusUsesStaticGenerationIndicators();

console.log("session page tests passed");
