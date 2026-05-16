import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TaskPage from "./TaskPage";

function noop() {}

function renderTaskPageWithPlan() {
  return renderToStaticMarkup(
    <TaskPage
      task={null}
      messages={[]}
      timelineEvents={[]}
      taskProgress={{ completed: 1, total: 2, currentTask: "Map event to UI" }}
      taskSteps={[
        { id: "codex-plan:turn-1:0", subject: "Inspect current bridge", status: "completed" },
        { id: "codex-plan:turn-1:1", subject: "Map event to UI", status: "in_progress" },
      ]}
      tokenUsage={{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }}
      lastContextTokens={0}
      input=""
      isGenerating={false}
      focusToken={0}
      selectedModel="codex-medium"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      isModelDropdownOpen={false}
      onInputChange={noop}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      onSend={noop}
      onStop={noop}
      onQuickReply={noop}
      onPermissionResolve={noop}
    />
  );
}

function testCompletedPlanStepUsesStrikethrough() {
  const html = renderTaskPageWithPlan();

  assert.match(html, /line-through/);
  assert.match(html, />Inspect current bridge</);
  assert.match(html, />Map event to UI</);
}

testCompletedPlanStepUsesStrikethrough();

console.log("task page plan tests passed");
