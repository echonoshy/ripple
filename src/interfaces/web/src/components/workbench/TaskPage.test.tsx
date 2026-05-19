import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TaskPage from "./TaskPage";

function noop() {}

function renderTaskPage() {
  return renderToStaticMarkup(
    <TaskPage
      session={null}
      messages={[]}
      timelineEvents={[]}
      taskProgress={null}
      taskSteps={[]}
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
      sessionIdCopied={false}
      onInputChange={noop}
      onClearContext={noop}
      onAttachFiles={noop}
      onRemovePendingFile={noop}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      onCopySessionId={noop}
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
      session={null}
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
      pendingFiles={[]}
      isGenerating={false}
      focusToken={0}
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      sessionId="srv-test"
      sessionIdCopied={false}
      onInputChange={noop}
      onClearContext={noop}
      onAttachFiles={noop}
      onRemovePendingFile={noop}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      onCopySessionId={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );
}

function testOmitsPlaceholderTaskHeaderControls() {
  const html = renderTaskPage();

  assert.match(html, /title="Copy session ID: srv-test"/);
  assert.match(html, /absolute top-3 right-4/);
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
  assert.match(html, /sm:hidden[^>]*>Start here</);
  assert.match(html, /hidden sm:inline[^>]*>Workspace briefing</);
  assert.match(html, />Files</);
  assert.match(html, />Sessions</);
  assert.match(html, />Ask</);
  assert.doesNotMatch(html, />Tasks</);
  assert.doesNotMatch(html, /Review recent tasks/);
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
