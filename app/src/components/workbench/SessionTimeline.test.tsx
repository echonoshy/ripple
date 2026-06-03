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
            id: "assistant-1",
            type: "assistant_message",
            title: "Update",
            body: "Agent generated content",
          },
          {
            id: "command-1",
            type: "command",
            title: "Command",
            body: "bun run build",
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

  assert.match(html, /aria-label="复制 Update 内容"/);
  assert.match(html, /title="复制内容"/);
  assert.match(generatingHtml, />正在思考/);
}

function testAssistantMessagesExposeCopyAction() {
  const html = renderTimelineWithEvents();

  assert.match(html, /aria-label="Copy Update content"/);
  assert.match(html, /title="Copy content"/);
}

function testCopyActionIsHiddenUntilMessageInteraction() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /group-hover\/timeline-event:opacity-100/);
  assert.match(source, /group-focus-within\/timeline-event:opacity-100/);
  assert.match(source, /pointer-events-none[\s\S]*opacity-0/);
}

function testToolEventsDoNotExposeCopyAction() {
  const html = renderTimelineWithEvents();

  assert.equal((html.match(/aria-label="Copy Command content"/g) || []).length, 0);
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
testCopyActionIsHiddenUntilMessageInteraction();
testToolEventsDoNotExposeCopyAction();
testGeneratingPlaceholderUsesRandomWaitingCopy();
testWaitingCopyAvoidsConcreteOperationClaims();
testTimelineUsesReadableMobileTypeScale();

console.log("session timeline tests passed");
