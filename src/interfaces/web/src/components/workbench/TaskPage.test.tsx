import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TaskPage from "./TaskPage";

function noop() {}

function renderTaskPage() {
  return renderToStaticMarkup(
    <TaskPage
      task={null}
      messages={[]}
      timelineEvents={[]}
      taskProgress={null}
      taskSteps={[]}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      lastContextTokens={0}
      input=""
      isGenerating={false}
      focusToken={0}
      onInputChange={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );
}

function renderTaskPageWithTimelineContent() {
  return renderToStaticMarkup(
    <TaskPage
      task={null}
      messages={[]}
      timelineEvents={[
        {
          id: "assistant-1",
          type: "assistant_message",
          title: "Codex update",
          body: "A wider timeline body should use the available task content width.",
        },
      ]}
      taskProgress={null}
      taskSteps={[]}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      lastContextTokens={0}
      input=""
      isGenerating={false}
      focusToken={0}
      onInputChange={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );
}

function testOmitsPlaceholderTaskHeaderControls() {
  const html = renderTaskPage();

  assert.match(html, />New Codex task</);
  assert.doesNotMatch(html, />Timeline</);
  assert.doesNotMatch(html, />Diff</);
  assert.doesNotMatch(html, />Logs</);
  assert.doesNotMatch(html, />Checks</);
  assert.doesNotMatch(html, />main</);
  assert.doesNotMatch(html, /Task focus/);
}

function testGivesTaskContentMoreHorizontalRoom() {
  const html = renderTaskPage();

  assert.match(html, /overflow-y-auto bg-white px-4 py-5 md:px-5/);
  assert.match(html, /mx-auto max-w-5xl space-y-5/);
}

function testTimelineTextUsesWiderContentWidth() {
  const html = renderTaskPageWithTimelineContent();

  assert.match(html, /markdown-body workbench-markdown max-w-4xl/);
}

testOmitsPlaceholderTaskHeaderControls();
testGivesTaskContentMoreHorizontalRoom();
testTimelineTextUsesWiderContentWidth();

console.log("task page tests passed");
