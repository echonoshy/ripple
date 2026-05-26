import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionPage from "./SessionPage";

function noop() {}
async function noopAsync() {
  return {};
}

function renderSessionPageWithPlan() {
  return renderToStaticMarkup(
    <SessionPage
      session={null}
      messages={[]}
      timelineEvents={[]}
      planProgress={{ completed: 1, total: 2, currentTask: "Map event to UI" }}
      planSteps={[
        { id: "codex-plan:turn-1:0", subject: "Inspect current bridge", status: "completed" },
        { id: "codex-plan:turn-1:1", subject: "Map event to UI", status: "in_progress" },
      ]}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      lastContextTokens={0}
      input=""
      pendingFiles={[]}
      isGenerating={false}
      focusToken={0}
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      sessionId="srv-plan"
      sessionIdCopied={false}
      onNewSession={noop}
      onUpdateSessionSettings={noopAsync}
      onInputChange={noop}
      onClearContext={noop}
      onCompactContext={noop}
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

function testCompletedPlanStepUsesStrikethrough() {
  const html = renderSessionPageWithPlan();

  assert.match(html, /line-through/);
  assert.match(html, />Inspect current bridge</);
  assert.match(html, />Map event to UI</);
}

testCompletedPlanStepUsesStrikethrough();

console.log("session page plan tests passed");
