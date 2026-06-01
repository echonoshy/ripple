import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionTimeline, { WAITING_STATUS_MESSAGES } from "./SessionTimeline";

function noop() {}

function renderTimelineWithEvents() {
  return renderToStaticMarkup(
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
  );
}

function renderGeneratingTimeline() {
  return renderToStaticMarkup(
    <SessionTimeline
      messages={[{ id: "assistant-waiting", role: "assistant", content: "" }]}
      events={[]}
      isGenerating
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
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

  assert.match(source, /Activity will appear here\./);
  assert.doesNotMatch(
    source,
    /Start a session and your workspace activity will appear here as a timeline\./
  );
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
  assert.match(source, /pointer-events-none opacity-0/);
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
    assert.match(html, new RegExp(WAITING_STATUS_MESSAGES[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

testTimelineImagePreviewsUseWorkspaceImageCache();
testEmptyTimelineUsesShortReadyCopy();
testAssistantMessagesExposeCopyAction();
testCopyActionIsHiddenUntilMessageInteraction();
testToolEventsDoNotExposeCopyAction();
testGeneratingPlaceholderUsesRandomWaitingCopy();
testWaitingCopyAvoidsConcreteOperationClaims();

console.log("session timeline tests passed");
