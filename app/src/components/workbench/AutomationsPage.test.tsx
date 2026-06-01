import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AutomationsPage from "./AutomationsPage";

const noop = () => {};

function renderAutomationsPage() {
  return renderToStaticMarkup(
    <AutomationsPage
      selectedModel="codex-medium"
      models={[
        { id: "codex-medium", owned_by: "ripple" },
        { id: "codex-high", owned_by: "ripple" },
      ]}
      onAuthExpired={noop}
      onBack={noop}
    />
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

function testAutomationFormCanSelectModel() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /models:\s*\{\s*id:\s*string;\s*owned_by:\s*string\s*\}\[\]/);
  assert.match(source, /const \[formModel, setFormModel\]/);
  assert.match(source, /<select[\s\S]*value=\{formModel\}/);
  assert.match(source, />Model</);
  assert.match(source, /availableModels\.map/);
  assert.match(source, /model:\s*formModel/);
}

function testExistingAutomationsCanBeEdited() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /editingScheduleId/);
  assert.match(source, /function beginEditSchedule/);
  assert.match(source, /await updateSchedule\(editingScheduleId/);
  assert.match(source, /"Save"/);
  assert.match(source, />Edit</);
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

function testAutomationCardUsesCompactResponsiveLayout() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /className="px-3 py-3 sm:px-4 sm:py-3"/);
  assert.match(source, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(220px,280px\)\]/);
  assert.match(source, /grid-cols-2 gap-1\.5 pl-9 sm:grid-cols-4 lg:grid-cols-3/);
  assert.match(source, /col-span-2 min-w-0 rounded-lg[\s\S]*sm:col-span-2 lg:col-span-1/);
  assert.match(source, /rounded-xl border border-\[#e8edf7\] bg-\[#f8fbff\]\/75 p-2\.5/);
  assert.match(source, /data-ripple-automation-actions[\s\S]*grid grid-cols-3/);
  assert.match(source, /sm:flex sm:flex-wrap sm:justify-end/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,220}overflow-x-auto/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*min-w-0/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*text-\[10px\] sm:text-\[11px\]/);
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
testAutomationFormCanSelectModel();
testExistingAutomationsCanBeEdited();
testAutomationRunResultsAreDiscoverable();
testAutomationCardUsesSeparatedLayoutRegions();
testAutomationCardUsesCompactResponsiveLayout();
testAutomationRunHistoryUsesReadableRows();

console.log("automations page tests passed");
