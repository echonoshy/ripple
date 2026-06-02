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
  assert.match(html, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
}

function testMobileBrandWordmarkHasQuietPersonality() {
  const html = renderMobileSessionsPage();
  const wordmarkClass =
    mobileSessionsPageSource.match(
      /data-ripple-mobile-brand-wordmark="true"[\s\S]{0,180}className="([^"]+)"/
    )?.[1] || "";

  assert.match(html, /data-ripple-mobile-brand-wordmark="true"/);
  assert.match(wordmarkClass, /text-\[19px\]/);
  assert.match(wordmarkClass, /font-\[650\]/);
  assert.match(wordmarkClass, /tracking-normal/);
  assert.doesNotMatch(wordmarkClass, /font-\[800\]/);
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /data-ripple-mobile-brand-wordmark="true"[\s\S]{0,520}bg-\[#007aff\]/
  );
  assert.doesNotMatch(wordmarkClass, /tracking-\[-/);
}

function testUsesQuietAgentControlPlaneStyling() {
  const html = renderMobileSessionsPage();

  assert.match(html, /bg-white\/78/);
  assert.match(html, /backdrop-blur-xl/);
  assert.match(html, /shadow-\[0_8px_24px_rgba\(60,60,67,0\.05\)\]/);
  assert.match(html, /rounded-2xl/);
  assert.doesNotMatch(html, /bg-gradient/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /radial-gradient/);
  assert.doesNotMatch(html, /rounded-\[18px\]/);
}

function testSessionRowsRemoveRepeatedChatIcon() {
  const html = renderMobileSessionsPage();

  assert.doesNotMatch(html, /class="lucide lucide-message-circle"/);
}

function testSearchInputUsesCompactType() {
  assert.match(mobileSessionsPageSource, /className="search-sessions-input[^"]*text-\[14px\]/);
  assert.doesNotMatch(
    mobileSessionsPageSource,
    /className="search-sessions-input[^"]*text-\[16px\]/
  );
}

function testHeaderActionsUseSharedGlassTreatment() {
  const html = renderMobileSessionsPage();
  const headerActionClass =
    mobileSessionsPageSource.match(/const mobileHeaderActionClass =\s+"([^"]+)"/)?.[1] || "";

  assert.match(html, /bg-white\/72/);
  assert.match(html, /backdrop-blur-xl/);
  assert.match(
    mobileSessionsPageSource,
    /mobileHeaderActionClass =\s+"inline-flex h-9 w-9 items-center justify-center rounded-full border border-white\/76 bg-white\/72 text-\[#3c3c43\]/
  );
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
  assert.doesNotMatch(headerActionClass, /bg-\[#007aff\]/);
  assert.doesNotMatch(html, /border-\[#007aff\] bg-\[#007aff\] text-white/);
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

function testRendersChineseMobileSessionChrome() {
  const html = renderMobileSessionsPage({}, "zh-CN");

  assert.match(html, /aria-label="搜索会话"/);
  assert.match(html, /aria-label="新会话"/);
  assert.match(html, /4 条消息 · 2 个文件/);
}

testRendersChatAppStyleSessionList();
testMobileBrandWordmarkHasQuietPersonality();
testUsesQuietAgentControlPlaneStyling();
testSessionRowsRemoveRepeatedChatIcon();
testSearchInputUsesCompactType();
testHeaderActionsUseSharedGlassTreatment();
testSessionRowsDoNotClipOptionsMenu();
testSessionOptionsMenuEscapesBlurredRowsWithPortal();
testRendersEmptyStateWithNewSessionAction();
testRendersChineseMobileSessionChrome();

console.log("mobile sessions page tests passed");
