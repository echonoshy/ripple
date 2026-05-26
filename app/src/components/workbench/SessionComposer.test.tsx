import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionComposer from "./SessionComposer";

function noop() {}

function renderComposer(overrides: Partial<React.ComponentProps<typeof SessionComposer>> = {}) {
  return renderToStaticMarkup(
    <SessionComposer
      value=""
      onChange={noop}
      onSend={noop}
      onStop={noop}
      onClearContext={noop}
      onCompactContext={noop}
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
      {...overrides}
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

  assert.match(html, /session-composer-input/);
  assert.match(globalCss, /\.session-composer-input:focus-visible/);
  assert.match(globalCss, /outline:\s*none/);
}

function testBlockedComposerStillAllowsDraftingAndShowsStop() {
  const html = renderComposer({ value: "draft", isBlocked: true });

  assert.match(html, />draft</);
  assert.doesNotMatch(html, /<textarea[^>]*\sdisabled="/);
  assert.match(html, /aria-label="Stop generation"/);
  assert.doesNotMatch(html, /aria-label="Send message"/);
}

function testComposerClearsIosHomeIndicatorAndUsesTouchSizedActions() {
  const html = renderComposer();

  assert.match(html, /pb-\[max\(env\(safe-area-inset-bottom\),8px\)\]/);
  assert.match(html, /h-10 w-10/);
  assert.match(html, /text-\[16px\][^"]*sm:text-\[14px\]/);
}

testShowsSelectedModelAndMenuOptions();
testComposerToolbarNamesRealActions();
testComposerInputSuppressesGlobalBlueFocusOutline();
testBlockedComposerStillAllowsDraftingAndShowsStop();
testComposerClearsIosHomeIndicatorAndUsesTouchSizedActions();

console.log("session composer tests passed");
