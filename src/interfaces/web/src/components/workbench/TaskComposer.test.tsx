import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  assert.match(html, /aria-label="Attach files"/);
  assert.doesNotMatch(html, /aria-label="Quick actions"/);
  assert.doesNotMatch(html, /aria-label="Mention workspace file"/);
  assert.doesNotMatch(html, /title="Quick actions"/);
  assert.doesNotMatch(html, /title="Mention workspace file"/);
}

function testComposerInputSuppressesGlobalBlueFocusOutline() {
  const html = renderComposer();
  const globalCss = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");

  assert.match(html, /task-composer-input/);
  assert.match(globalCss, /\.task-composer-input:focus-visible/);
  assert.match(globalCss, /outline:\s*none/);
}

testShowsSelectedModelAndMenuOptions();
testComposerToolbarNamesRealActions();
testComposerInputSuppressesGlobalBlueFocusOutline();

console.log("task composer tests passed");
