import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import WorkspaceFolderPicker from "./WorkspaceFolderPicker";

function noop() {}

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof WorkspaceFolderPicker>> = {},
  locale: LocalePreference = "en-US"
) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <WorkspaceFolderPicker onSelectFolder={noop} onClose={noop} {...overrides} />
    </I18nProvider>
  );
}

function testPickerAvoidsFeatureExplanationCopy() {
  const html = renderPicker();

  assert.match(html, />Choose work folder</);
  assert.doesNotMatch(html, />Choose focus folder</);
  assert.doesNotMatch(html, /Agent looks here first/);
  assert.doesNotMatch(html, /Open a folder, then choose it/);
  assert.doesNotMatch(html, /Use full workspace/);
  assert.doesNotMatch(html, /aria-label="Close folder picker"/);
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

  assert.match(source, /t\("files\.openFolder"/);
  assert.match(source, /t\("files\.selectFocusFolder"/);
  assert.match(source, /<ChevronRight/);
  assert.match(source, /<Check/);
  assert.doesNotMatch(source, /<X size=\{15\}/);
  assert.doesNotMatch(source, /Use this folder as focus/);
}

testPickerAvoidsFeatureExplanationCopy();
testPickerOnlyOffersCancelWhenFocusFolderExists();
testPickerSeparatesEnteringFoldersFromSelectingFolders();

function testPickerUsesSofterFolderRows() {
  const source = readFileSync(new URL("./WorkspaceFolderPicker.tsx", import.meta.url), "utf8");

  assert.match(source, /<Folder size=\{14\} className="shrink-0 text-\[#5aaeff\]"/);
  assert.match(source, /<span className="min-w-0 flex-1 truncate font-semibold"/);
}

testPickerUsesSofterFolderRows();

function testPickerRendersChineseChrome() {
  const html = renderPicker({}, "zh-CN");

  assert.match(html, />选择工作文件夹</);
  assert.doesNotMatch(html, />选择焦点文件夹</);
  assert.doesNotMatch(html, /aria-label="关闭文件夹选择器"/);
  assert.match(html, />这里没有文件夹</);
}

testPickerRendersChineseChrome();

console.log("workspace folder picker tests passed");
