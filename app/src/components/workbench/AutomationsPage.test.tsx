import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import AutomationsPage from "./AutomationsPage";

const noop = () => {};

function renderAutomationsPage(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <AutomationsPage
        selectedModel="codex-medium"
        models={[
          { id: "codex-medium", owned_by: "ripple" },
          { id: "codex-high", owned_by: "ripple" },
        ]}
        onAuthExpired={noop}
        onBack={noop}
      />
    </I18nProvider>
  );
}

function testAutomationsPageHasMobileBackNavigation() {
  const html = renderAutomationsPage();

  assert.match(html, />Autos</);
  assert.match(html, /aria-label="Back to settings"/);
  assert.match(html, /lg:hidden/);
}

function testAutomationActionsUseVisibleDistinctLabels() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /t\("automations\.pause"\)/);
  assert.match(source, /t\("automations\.resume"\)/);
  assert.match(source, /t\("automations\.runNow"\)/);
  assert.match(source, /t\("automations\.delete"\)/);
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
  assert.match(source, /t\("automations\.model"\)/);
  assert.match(source, /availableModels\.map/);
  assert.match(source, /model:\s*formModel/);
}

function testExistingAutomationsCanBeEdited() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /editingScheduleId/);
  assert.match(source, /function beginEditSchedule/);
  assert.match(source, /await updateSchedule\(editingScheduleId/);
  assert.match(source, /t\("automations\.save"\)/);
  assert.match(source, /t\("automations\.edit"\)/);
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
  assert.match(source, /t\("automations\.viewOutput"\)/);
  assert.match(source, /t\("automations\.downloadOutput"\)/);
  assert.match(source, /t\("automations\.deleteRecord"\)/);
  assert.match(source, /t\("automations\.runHistory"\)/);
}

function testRunningAutomationRunsDoNotOfferOutputActions() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /function hasRunOutput/);
  assert.match(source, /run\?\.output_available && !isActiveRunStatus\(run\.status\)/);
  assert.doesNotMatch(source, /run\?\.output_file/);
}

function testCompletedScheduleRunsDoNotSurfaceToolStderrAsErrors() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /function runErrorText/);
  assert.match(source, /stripAnsi/);
  assert.match(
    source,
    /if \(!\(run\.status === "failed" \|\| run\.status === "cancelled"\)\) return null;/
  );
  assert.match(
    source,
    /const scheduleError = schedule\.status === "error" \? schedule\.last_error : null;/
  );
  assert.match(source, /schedule\.status === "error" && schedule\.last_error/);
  assert.doesNotMatch(source, /run\.stderr_tail\?\.trim\(\)\s*\|\|/);
}

function testAutomationStaticCopyUsesEnglish() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(
    source,
    /查看结果|下载结果|运行记录|删除记录|确认删除|执行记录|运行中|取消|已失效|失败/
  );
}

function testAutomationCardUsesSeparatedLayoutRegions() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-card-main/);
  assert.match(source, /data-ripple-automation-summary/);
  assert.match(source, /data-ripple-automation-meta-grid/);
  assert.match(source, /data-ripple-automation-latest-run/);
  assert.match(source, /data-ripple-automation-actions/);
}

function testAutomationCardDoesNotExposePolicyControls() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, />\s*Policy\s*</);
  assert.doesNotMatch(source, /missed_run_policy/);
  assert.doesNotMatch(source, /overlap_policy/);
  assert.doesNotMatch(source, /failure_policy/);
}

function testAutomationCardUsesCompactResponsiveLayout() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.match(source, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(source, /className=\{`\$\{MOBILE_GLASS_ICON_BUTTON_CLASS\} shrink-0/);
  assert.match(source, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
  assert.match(source, /MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS/);
  assert.match(source, /LUCIDE_NAV_STROKE_WIDTH/);
  assert.doesNotMatch(source, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /circle_at_16%_0%/);
  assert.match(
    source,
    /data-ripple-automation-card-main[\s\S]*className="overflow-hidden rounded-xl border border-\[#DEE0E3\] bg-white\/88 px-3 py-2 shadow-\[0_10px_24px_rgba\(31,35,41,0\.055\)\] backdrop-blur-xl sm:px-4 sm:py-2\.5 xl:px-5"/
  );
  assert.match(source, /data-ripple-automation-list[\s\S]{0,80}className="grid gap-2\.5"/);
  assert.doesNotMatch(source, /data-ripple-automation-list[\s\S]{0,120}divide-y/);
  assert.match(source, /xl:grid-cols-\[minmax\(260px,0\.82fr\)_minmax\(0,1\.35fr\)\]/);
  assert.match(source, /data-ripple-automation-detail-grid/);
  assert.match(source, /data-ripple-automation-detail-grid[\s\S]{0,130}className="grid gap-1\.5/);
  assert.doesNotMatch(source, /data-ripple-automation-detail-grid[\s\S]{0,120}pl-8/);
  assert.match(
    source,
    /data-ripple-automation-meta-grid[\s\S]*className="grid grid-cols-2 gap-1\.5 md:grid-cols-1"/
  );
  assert.match(source, /data-ripple-automation-meta-cell/);
  assert.doesNotMatch(source, /data-ripple-automation-meta-chip/);
  assert.doesNotMatch(source, /data-ripple-automation-meta-grid[\s\S]{0,120}flex flex-wrap/);
  assert.match(source, /TYPOGRAPHY_META_CLASS/);
  assert.match(source, /mt-0\.5 truncate text-\[#2B2F36\]/);
  assert.match(
    source,
    /data-ripple-automation-latest-run[\s\S]*rounded-lg border border-\[#EFF0F1\] bg-\[#F8F9FA\]\/70 px-2 py-1\.5/
  );
  assert.match(source, /data-ripple-automation-latest-run[\s\S]*grid min-w-0 gap-1\.5/);
  assert.doesNotMatch(source, /const latestRunId/);
  assert.doesNotMatch(source, /\{latestRunId \|\| "No run"\}/);
  assert.match(source, /latestRunAt[\s\S]*formatDate\(latestRunAt, locale, t\)/);
  assert.match(source, /data-ripple-automation-actions[\s\S]*mt-2 grid grid-cols-3 gap-1\.5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,120}pl-8/);
  assert.match(source, /md:grid-cols-5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,220}overflow-x-auto/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,180}border-t/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*w-full/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*TYPOGRAPHY_META_MEDIUM_CLASS/);
  assert.match(source, /const runActionButtonClass =[\s\S]*h-8/);
}

function testAutomationCardUsesDesktopRowLayout() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /data-ripple-automation-card-main[\s\S]*className="overflow-hidden rounded-xl border border-\[#DEE0E3\] bg-white\/88 px-3 py-2 shadow-\[0_10px_24px_rgba\(31,35,41,0\.055\)\] backdrop-blur-xl sm:px-4 sm:py-2\.5 xl:px-5"/
  );
  assert.match(source, /xl:grid-cols-\[minmax\(260px,0\.82fr\)_minmax\(0,1\.35fr\)\]/);
  assert.match(
    source,
    /data-ripple-automation-detail-grid[\s\S]*md:grid-cols-\[minmax\(150px,220px\)_minmax\(0,1fr\)\]/
  );
  assert.match(
    source,
    /data-ripple-automation-meta-grid[\s\S]*className="grid grid-cols-2 gap-1\.5 md:grid-cols-1"/
  );
  assert.doesNotMatch(source, /data-ripple-automation-meta-grid[\s\S]{0,120}sm:grid-cols-3/);
  assert.doesNotMatch(source, /col-span-2 min-w-0[\s\S]*sm:col-span-1/);
  assert.match(source, /data-ripple-automation-actions[\s\S]*md:grid-cols-5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,160}sm:flex/);
}

function testAutomationRunHistoryUsesReadableRows() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-run-history/);
  assert.match(source, /data-ripple-automation-run-row/);
  assert.match(source, /divide-y divide-\[#EFF0F1\]/);
  assert.match(source, /max-h-44 overflow-y-auto/);
  assert.match(source, /data-ripple-automation-run-row[\s\S]*py-1\.5/);
  assert.match(source, /sm:grid-cols-\[90px_minmax\(0,1fr\)_120px\]/);
}

function testAutomationsPageRendersChineseChrome() {
  const html = renderAutomationsPage("zh-CN");

  assert.match(html, />自动化</);
  assert.match(html, /aria-label="返回设置"/);
  assert.match(html, />新建</);
  assert.match(html, />暂无自动化</);
}

testAutomationsPageHasMobileBackNavigation();
testAutomationActionsUseVisibleDistinctLabels();
testTimezoneUsesSelectControl();
testAutomationFormCanSelectModel();
testExistingAutomationsCanBeEdited();
testAutomationRunResultsAreDiscoverable();
testRunningAutomationRunsDoNotOfferOutputActions();
testCompletedScheduleRunsDoNotSurfaceToolStderrAsErrors();
testAutomationStaticCopyUsesEnglish();
testAutomationCardUsesSeparatedLayoutRegions();
testAutomationCardDoesNotExposePolicyControls();
testAutomationCardUsesCompactResponsiveLayout();
testAutomationCardUsesDesktopRowLayout();
testAutomationRunHistoryUsesReadableRows();
testAutomationsPageRendersChineseChrome();

console.log("automations page tests passed");
