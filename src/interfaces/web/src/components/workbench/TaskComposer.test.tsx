import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TaskComposer from "./TaskComposer";

function noop() {}

function renderComposer() {
  return renderToStaticMarkup(
    <TaskComposer
      value=""
      onChange={noop}
      onSend={noop}
      onStop={noop}
      isGenerating={false}
      hasSession={false}
      focusToken={0}
      selectedModel="codex-high"
      models={[
        { id: "codex-medium", owned_by: "ripple" },
        { id: "codex-high", owned_by: "ripple" },
      ]}
      isModelDropdownOpen={true}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
    />
  );
}

function testShowsSelectedModelAndMenuOptions() {
  const html = renderComposer();

  assert.match(html, />codex-high</);
  assert.match(html, />codex-medium</);
  assert.doesNotMatch(html, />Codex</);
}

testShowsSelectedModelAndMenuOptions();

console.log("task composer tests passed");
