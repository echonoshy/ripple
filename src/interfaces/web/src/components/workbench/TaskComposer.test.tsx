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
      onClearContext={noop}
      onAttachFiles={noop}
      onSearchWorkspaceFiles={async () => []}
      onAddWorkspaceFile={noop}
      onRemovePendingFile={noop}
      pendingFiles={[]}
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

function testComposerToolbarNamesRealActions() {
  const html = renderComposer();

  assert.match(html, /aria-label="Quick actions"/);
  assert.match(html, /aria-label="Attach files"/);
  assert.match(html, /aria-label="Mention workspace file"/);
}

testShowsSelectedModelAndMenuOptions();
testComposerToolbarNamesRealActions();

console.log("task composer tests passed");
