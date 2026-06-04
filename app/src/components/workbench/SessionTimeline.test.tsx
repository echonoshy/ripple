import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import SessionTimeline, { WAITING_STATUS_MESSAGES } from "./SessionTimeline";

function noop() {}

function renderTimelineWithEvents(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <SessionTimeline
        messages={[]}
        events={[
          {
            id: "user-1",
            type: "user_message",
            title: "User request",
            body: "Tell me a joke",
          },
          {
            id: "assistant-1",
            type: "assistant_message",
            title: "Update",
            body: "Agent generated content",
          },
          {
            id: "command-1",
            type: "command",
            title: "Command output",
            body: "bun run build",
            status: "running",
          },
        ]}
        isGenerating={false}
        onQuickReply={noop}
        onPermissionResolve={noop}
      />
    </I18nProvider>
  );
}

function renderGeneratingTimeline(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <SessionTimeline
        messages={[{ id: "assistant-waiting", role: "assistant", content: "" }]}
        events={[]}
        isGenerating
        onQuickReply={noop}
        onPermissionResolve={noop}
      />
    </I18nProvider>
  );
}

function testTimelineImagePreviewsUseWorkspaceImageCache() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /getWorkspaceImagePreviewUrl/);
  assert.doesNotMatch(source, /URL\.createObjectURL/);
  assert.doesNotMatch(source, /URL\.revokeObjectURL/);
}

function testEmptyTimelineUsesShortReadyCopy() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /t\("timeline\.activityWillAppear"\)/);
  assert.doesNotMatch(
    source,
    /Start a session and your workspace activity will appear here as a timeline\./
  );
}

function testTimelineRendersChineseStaticCopy() {
  const html = renderTimelineWithEvents("zh-CN");
  const generatingHtml = renderGeneratingTimeline("zh-CN");

  assert.match(html, />提问</);
  assert.match(html, />回复</);
  assert.match(html, />命令输出</);
  assert.match(html, />运行中</);
  assert.doesNotMatch(html, />你说</);
  assert.doesNotMatch(html, />Ripple 回复</);
  assert.doesNotMatch(html, />User request</);
  assert.doesNotMatch(html, />Update</);
  assert.doesNotMatch(html, />running</);
  assert.match(html, /aria-label="复制回复内容"/);
  assert.match(html, /title="复制内容"/);
  assert.doesNotMatch(generatingHtml, />正在思考/);
}

function testAssistantMessagesExposeCopyAction() {
  const html = renderTimelineWithEvents();

  assert.match(html, />Request</);
  assert.match(html, />Reply</);
  assert.doesNotMatch(html, />You</);
  assert.doesNotMatch(html, />Ripple</);
  assert.doesNotMatch(html, />User request</);
  assert.doesNotMatch(html, />Update</);
  assert.match(html, /aria-label="Copy Reply content"/);
  assert.match(html, /title="Copy content"/);
}

function testUserAndAssistantIconsUseDifferentTones() {
  const html = renderTimelineWithEvents("zh-CN");

  assert.match(html, /data-tone="neutral"[\s\S]*>\s*提问/);
  assert.match(html, /data-tone="accent"[\s\S]*>\s*回复/);
}

function testTimelineEventHeadersAlignIconAndTextRows() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /className="group\/timeline-event[\s\S]*sm:py-4"/);
  assert.match(source, /className="absolute top-2\.5 sm:top-4 -left-8/);
  assert.match(source, /className="mb-1\.5 flex min-h-6 items-center justify-between gap-3"/);
}

function testCopyActionIsHiddenUntilMessageInteraction() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /lg:group-hover\/timeline-event:opacity-100/);
  assert.match(source, /lg:group-focus-within\/timeline-event:opacity-100/);
  assert.match(source, /lg:pointer-events-none[\s\S]*lg:opacity-0/);
}

function testCopyActionStaysVisibleOnMobile() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /pointer-events-auto[\s\S]*opacity-100[\s\S]*lg:pointer-events-none[\s\S]*lg:opacity-0/
  );
}

function testToolEventsDoNotExposeCopyAction() {
  const html = renderTimelineWithEvents();

  assert.equal((html.match(/aria-label="Copy Command output content"/g) || []).length, 0);
}

function testGeneratingPlaceholderUsesRandomWaitingCopy() {
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    const html = renderGeneratingTimeline();

    assert.ok(WAITING_STATUS_MESSAGES.length >= 40);
    assert.match(
      html,
      new RegExp(WAITING_STATUS_MESSAGES[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.doesNotMatch(html, /Starting work\.\.\./);
  } finally {
    Math.random = originalRandom;
  }
}

function testChineseGeneratingPlaceholderUsesRandomWaitingCopy() {
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    const html = renderGeneratingTimeline("zh-CN");

    assert.match(html, />我看一下。/);
    assert.doesNotMatch(html, /正在思考/);
  } finally {
    Math.random = originalRandom;
  }
}

function testWaitingCopyAvoidsConcreteOperationClaims() {
  const concreteOperationPattern =
    /\b(shortcut|workspace|files?|context|diff|wiring|toolbox|path|thread|signal|lever|clues|map|terrain|reading|checking|tracing|opening|running|testing|gathering|mapping)\b/i;

  for (const message of WAITING_STATUS_MESSAGES) {
    assert.doesNotMatch(message, concreteOperationPattern);
  }
}

function testTimelineUsesReadableMobileTypeScale() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /TYPOGRAPHY_BODY_CLASS/);
  assert.match(source, /TYPOGRAPHY_BODY_MEDIUM_CLASS/);
  assert.match(source, /TYPOGRAPHY_META_CLASS/);
  assert.match(source, /TYPOGRAPHY_MICRO_CLASS/);
  assert.doesNotMatch(source, /text-\[10px\]/);
}

testTimelineImagePreviewsUseWorkspaceImageCache();
testEmptyTimelineUsesShortReadyCopy();
testTimelineRendersChineseStaticCopy();
testAssistantMessagesExposeCopyAction();
testUserAndAssistantIconsUseDifferentTones();
testTimelineEventHeadersAlignIconAndTextRows();
testCopyActionIsHiddenUntilMessageInteraction();
testCopyActionStaysVisibleOnMobile();
testToolEventsDoNotExposeCopyAction();
testGeneratingPlaceholderUsesRandomWaitingCopy();
testChineseGeneratingPlaceholderUsesRandomWaitingCopy();
testWaitingCopyAvoidsConcreteOperationClaims();
testTimelineUsesReadableMobileTypeScale();

console.log("session timeline tests passed");
