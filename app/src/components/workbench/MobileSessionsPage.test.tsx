import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
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
const multiSessions: WorkbenchSessionSummary[] = [
  sessions[0],
  {
    sessionId: "srv-2",
    title: "Quiet follow-up",
    pinned: true,
    status: "idle",
    model: "codex-medium",
    lastActivityAt: "2026-05-16T00:00:00Z",
    messageCount: 2,
    changedFileCount: 0,
    pendingApprovalCount: 0,
  },
];

function renderMobileSessionsPage(
  overrides: Partial<React.ComponentProps<typeof MobileSessionsPage>> = {},
  locale: LocalePreference = "en-US"
) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
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
    </I18nProvider>
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
  assert.match(html, /pb-\[calc\(84px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),12px\)\]/);
}

function testMobileBrandWordmarkHasQuietPersonality() {
  const html = renderMobileSessionsPage();
  assert.match(html, /data-ripple-mobile-brand-wordmark="true"/);
  assert.match(mobileSessionsPageSource, /TYPOGRAPHY_PAGE_TITLE_CLASS/);
  assert.doesNotMatch(mobileSessionsPageSource, /font-\[800\]/);
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /data-ripple-mobile-brand-wordmark="true"[\s\S]{0,520}bg-\[#1456F0\]/
  );
  assert.doesNotMatch(mobileSessionsPageSource, /tracking-\[-/);
}

function testUsesQuietAgentControlPlaneStyling() {
  const html = renderMobileSessionsPage({ sessions: multiSessions, selectedSessionId: "srv-1" });

  assert.match(html, /border-\[#DEE0E3\]/);
  assert.match(html, /bg-white/);
  assert.match(html, /shadow-\[0_1px_2px_rgba\(31,35,41,0\.04\)\]/);
  assert.match(html, /data-ripple-mobile-session-row="true"/);
  assert.match(html, /data-ripple-mobile-session-row-selected="true"/);
  assert.match(html, /data-ripple-mobile-session-row-selected="false"/);
  assert.match(html, /rounded-lg/);
  assert.match(html, /border-\[#9DBBFF\]/);
  assert.match(html, /border-\[#D8DEE8\]/);
  assert.match(html, /shadow-\[0_2px_8px_rgba\(31,35,41,0\.05\)\]/);
  assert.doesNotMatch(html, /backdrop-blur-xl/);
  assert.doesNotMatch(html, /bg-gradient/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /radial-gradient/);
  assert.doesNotMatch(html, /rounded-\[18px\]/);
}

function testOnlySelectedSessionShowsOptionsButton() {
  const html = renderMobileSessionsPage({ sessions: multiSessions, selectedSessionId: "srv-1" });

  assert.equal((html.match(/aria-label="Session options"/g) || []).length, 1);
  assert.match(html, /data-ripple-mobile-session-options-visible="true"/);
  assert.match(html, /data-ripple-mobile-session-row-selected="false"/);
  assert.doesNotMatch(html, /Quiet follow-up[\s\S]{0,900}aria-label="Session options"/);
}

function testSessionRowsRemoveRepeatedChatIcon() {
  const html = renderMobileSessionsPage();

  assert.doesNotMatch(html, /class="lucide lucide-message-circle"/);
}

function testSearchInputUsesReadableMobileType() {
  assert.match(mobileSessionsPageSource, /className="search-sessions-input[^"]*text-\[16px\]/);
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /className="search-sessions-input[^"]*text-\[14px\]/
  );
}

function testHeaderActionsUseSharedWorkbenchTreatment() {
  const html = renderMobileSessionsPage();

  assert.match(
    mobileSessionsPageSource,
    /mobileHeaderActionClass = WORKBENCH_MOBILE_ICON_BUTTON_CLASS/
  );
  assert.match(mobileSessionsPageSource, /WORKBENCH_PAGE_BACKGROUND_CLASS/);
  assert.match(html, /inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl/);
  assert.doesNotMatch(html, /backdrop-blur-xl/);
  assert.doesNotMatch(mobileSessionsPageSource, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(
    mobileSessionsPageSource,
    /aria-label=\{t\("sessions.search"\)\}[\s\S]{0,220}className=\{mobileHeaderActionClass\}/
  );
  assert.match(mobileSessionsPageSource, /MessageSquarePlus/);
  assert.match(
    mobileSessionsPageSource,
    /aria-label=\{t\("sessions.newSession"\)\}[\s\S]*?<MessageCircleMore size=\{18\}/
  );
  assert.match(mobileSessionsPageSource, /Ellipsis/);
  assert.doesNotMatch(mobileSessionsPageSource, /<Plus size=\{18\}/);
  assert.doesNotMatch(mobileSessionsPageSource, /<SquarePen size=\{18\}/);
  assert.doesNotMatch(mobileSessionsPageSource, /<MoreHorizontal size=\{18\}/);
  assert.doesNotMatch(mobileSessionsPageSource, /<Settings2 size=\{18\}/);
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /aria-label=\{t\("sessions.newSession"\)\}[\s\S]*?<MessageSquarePlus size=\{18\}/
  );
  assert.doesNotMatch(html, /border-\[#1456F0\] bg-\[#1456F0\] text-white/);
}

function testSessionRowsUseMobileActionSheetForOptions() {
  const html = renderMobileSessionsPage();
  const source = readFileSync(new URL("./MobileSessionsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(html, /overflow-hidden rounded-lg border/);
  assert.match(source, /import MobileActionSheet from "\.\/MobileActionSheet"/);
  assert.match(source, /data-ripple-mobile-session-actions-sheet/);
  assert.match(source, /activeMenuSessionId/);
  assert.match(source, /setActiveMenuSessionId/);
  assert.match(source, /tone: "danger"/);
  assert.doesNotMatch(source, /getMeasuredViewportMenuPosition/);
  assert.doesNotMatch(source, /getMobileSessionMenuPosition/);
  assert.doesNotMatch(source, /position: "fixed"/);
  assert.doesNotMatch(source, /absolute top-12 right-3/);
}

function testSessionOptionsSheetEscapesBlurredRowsWithSharedPortal() {
  const source = readFileSync(new URL("./MobileSessionsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /<MobileActionSheet/);
  assert.match(source, /open=\{Boolean\(activeMenuSession\)\}/);
  assert.match(source, /onClose=\{\(\) => setActiveMenuSessionId\(null\)\}/);
}

function testMobileSessionSearchHasExplicitCancelState() {
  const source = readFileSync(new URL("./MobileSessionsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-mobile-search-cancel/);
  assert.match(source, /setIsSearching\(false\)/);
  assert.match(source, /setQuery\(""\)/);
}

function testSessionRowsExposeIosStyleSwipeActions() {
  const html = renderMobileSessionsPage();
  const leadingActionsSource =
    mobileSessionsPageSource.match(/leadingActions=\{\[([\s\S]*?)\]\}\s*trailingActions=/)?.[1] ||
    "";
  const trailingActionsSource =
    mobileSessionsPageSource.match(/trailingActions=\{\[([\s\S]*?)\]\}\s*className=/)?.[1] || "";

  assert.match(mobileSessionsPageSource, /import SwipeActionRow/);
  assert.match(mobileSessionsPageSource, /data-ripple-mobile-session-swipe/);
  assert.match(mobileSessionsPageSource, /trailingActions=\{/);
  assert.match(mobileSessionsPageSource, /leadingActions=\{/);
  assert.match(leadingActionsSource, /key: "pin"/);
  assert.doesNotMatch(leadingActionsSource, /key: "rename"/);
  assert.doesNotMatch(leadingActionsSource, /key: "delete"/);
  assert.match(trailingActionsSource, /key: "rename"/);
  assert.match(trailingActionsSource, /key: "delete"/);
  assert.doesNotMatch(trailingActionsSource, /key: "pin"/);
  assert.doesNotMatch(mobileSessionsPageSource, /onSwipeRightCommit=\{\(\) => \{/);
  assert.match(html, /data-ripple-swipe-row/);
  assert.match(html, /data-ripple-mobile-session-swipe/);
  assert.match(html, /data-ripple-swipe-actions="trailing"[^>]*opacity-0/);
  assert.match(html, /data-ripple-swipe-actions="leading"[^>]*opacity-0/);
}

function testMobileSessionChromeUsesMotionPresence() {
  assert.match(
    mobileSessionsPageSource,
    /import \{ AnimatePresence, motion \} from "framer-motion"/
  );
  assert.match(mobileSessionsPageSource, /menuTransition/);
  assert.match(mobileSessionsPageSource, /searchExpandVariants/);
  assert.match(mobileSessionsPageSource, /listItemVariants/);
  assert.match(mobileSessionsPageSource, /data-ripple-mobile-search-motion/);
}

function testMobileSessionRowsUseReadableTypeScale() {
  assert.match(mobileSessionsPageSource, /TYPOGRAPHY_MOBILE_BODY_CLASS/);
  assert.match(mobileSessionsPageSource, /TYPOGRAPHY_META_CLASS/);
  assert.match(mobileSessionsPageSource, /TYPOGRAPHY_MICRO_CLASS/);
  assert.doesNotMatch(mobileSessionsPageSource, /text-\[9px\]/);
}

function testRendersEmptyStateWithNewSessionAction() {
  const html = renderMobileSessionsPage({ sessions: [], selectedSessionId: null });

  assert.match(html, />No sessions yet</);
  assert.match(html, />New session</);
}

function testRendersChineseMobileSessionChrome() {
  const html = renderMobileSessionsPage({}, "zh-CN");

  assert.match(html, /aria-label="搜索会话"/);
  assert.match(html, /aria-label="新会话"/);
  assert.match(html, /4 条消息 · 2 个文件/);
}

function testMobileSessionOptionsButtonUsesChineseAccessibleLabel() {
  const html = renderMobileSessionsPage({}, "zh-CN");

  assert.match(html, /aria-label="会话选项"/);
  assert.match(html, /title="会话选项"/);
}

testRendersChatAppStyleSessionList();
testMobileBrandWordmarkHasQuietPersonality();
testUsesQuietAgentControlPlaneStyling();
testOnlySelectedSessionShowsOptionsButton();
testSessionRowsRemoveRepeatedChatIcon();
testSearchInputUsesReadableMobileType();
testHeaderActionsUseSharedWorkbenchTreatment();
testSessionRowsUseMobileActionSheetForOptions();
testSessionOptionsSheetEscapesBlurredRowsWithSharedPortal();
testMobileSessionSearchHasExplicitCancelState();
testSessionRowsExposeIosStyleSwipeActions();
testMobileSessionChromeUsesMotionPresence();
testMobileSessionRowsUseReadableTypeScale();
testRendersEmptyStateWithNewSessionAction();
testRendersChineseMobileSessionChrome();
testMobileSessionOptionsButtonUsesChineseAccessibleLabel();

console.log("mobile sessions page tests passed");
