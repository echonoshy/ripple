import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionTimeline from "./SessionTimeline";

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

testTimelineImagePreviewsUseWorkspaceImageCache();
testEmptyTimelineUsesShortReadyCopy();
testAssistantMessagesExposeCopyAction();
testCopyActionIsHiddenUntilMessageInteraction();
testToolEventsDoNotExposeCopyAction();

console.log("session timeline tests passed");
