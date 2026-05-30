import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AutomationsPage from "./AutomationsPage";

const noop = () => {};

function renderAutomationsPage() {
  return renderToStaticMarkup(
    <AutomationsPage selectedModel="codex-medium" onAuthExpired={noop} onBack={noop} />
  );
}

function testAutomationsPageHasMobileBackNavigation() {
  const html = renderAutomationsPage();

  assert.match(html, />Automations</);
  assert.match(html, /aria-label="Back to settings"/);
  assert.match(html, /lg:hidden/);
}

function testAutomationActionsUseVisibleDistinctLabels() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, />Pause</);
  assert.match(source, />Resume</);
  assert.match(source, />Run now</);
  assert.match(source, />Delete</);
}

function testTimezoneUsesSelectControl() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /<select[\s\S]*value=\{timezone\}/);
  assert.doesNotMatch(source, /<input[\s\S]{0,200}value=\{timezone\}/);
  assert.match(source, /Asia\/Shanghai/);
}

function testAutomationRunResultsAreDiscoverable() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchScheduleRuns/);
  assert.match(source, /fetchRunOutputText/);
  assert.match(source, /downloadRunOutput/);
  assert.match(source, /deleteScheduleRun/);
  assert.match(source, /saveBlobAsDownload/);
  assert.match(source, /hasRunOutput/);
  assert.match(source, /output_available/);
  assert.match(source, /查看结果/);
  assert.match(source, /下载结果/);
  assert.match(source, /删除记录/);
  assert.match(source, /运行记录/);
}

function testAutomationCardUsesSeparatedLayoutRegions() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-card-main/);
  assert.match(source, /data-ripple-automation-summary/);
  assert.match(source, /data-ripple-automation-meta-grid/);
  assert.match(source, /data-ripple-automation-latest-run/);
  assert.match(source, /data-ripple-automation-actions/);
}

function testAutomationRunHistoryUsesReadableRows() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-run-history/);
  assert.match(source, /data-ripple-automation-run-row/);
  assert.match(source, /divide-y divide-\[#eef2fb\]/);
  assert.match(source, /sm:grid-cols-\[90px_minmax\(0,1fr\)_120px\]/);
}

testAutomationsPageHasMobileBackNavigation();
testAutomationActionsUseVisibleDistinctLabels();
testTimezoneUsesSelectControl();
testAutomationRunResultsAreDiscoverable();
testAutomationCardUsesSeparatedLayoutRegions();
testAutomationRunHistoryUsesReadableRows();

console.log("automations page tests passed");
