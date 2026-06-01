import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkspaceFolderPicker from "./WorkspaceFolderPicker";

function noop() {}

function renderPicker(overrides: Partial<React.ComponentProps<typeof WorkspaceFolderPicker>> = {}) {
  return renderToStaticMarkup(
    <WorkspaceFolderPicker onSelectFolder={noop} onClose={noop} {...overrides} />
  );
}

function testPickerAvoidsFeatureExplanationCopy() {
  const html = renderPicker();

  assert.match(html, />Choose focus folder</);
  assert.doesNotMatch(html, /Agent looks here first/);
  assert.doesNotMatch(html, /Open a folder, then choose it/);
  assert.doesNotMatch(html, /Use full workspace/);
}

function testPickerOnlyOffersCancelWhenFocusFolderExists() {
  const defaultHtml = renderPicker();
  const focusedHtml = renderPicker({ contextFolderPath: "/workspace/demo" });

  assert.doesNotMatch(defaultHtml, /Cancel selection/);
  assert.match(focusedHtml, /Selected/);
  assert.match(focusedHtml, /demo/);
  assert.match(focusedHtml, /Cancel selection/);
}

function testPickerSeparatesEnteringFoldersFromSelectingFolders() {
  const source = readFileSync(new URL("./WorkspaceFolderPicker.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label=\{`Open \$\{entry\.name\}`\}/);
  assert.match(source, /aria-label=\{`Select \$\{entry\.name\} as focus folder`\}/);
  assert.match(source, /<ChevronRight/);
  assert.match(source, /<Check/);
  assert.doesNotMatch(source, /Use this folder as focus/);
}

testPickerAvoidsFeatureExplanationCopy();
testPickerOnlyOffersCancelWhenFocusFolderExists();
testPickerSeparatesEnteringFoldersFromSelectingFolders();

console.log("workspace folder picker tests passed");
