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
        onOpenChat={noop}
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

function testNewAutomationOpensChatInsteadOfCreateForm() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /onOpenChat\?: \(prompt: string, options\?: \{ autoSend\?: boolean; newSession\?: boolean \}\) => void/);
  assert.match(source, /const openCreateAutomationChat = useCallback/);
  assert.match(
    source,
    /onOpenChat\?\.\(t\("automations\.createChatPrompt"\), \{ autoSend: true, newSession: true \}\)/
  );
  assert.match(source, /onClick=\{openCreateAutomationChat\}/);
  assert.doesNotMatch(source, /createSchedule/);
  assert.doesNotMatch(source, /beginCreateSchedule/);
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
    /查看结果|下载结果|运行记录|删除记录|确认删除|执行记录|运行中|已失效|失败/
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

function testAutomationConfigExposesAdvancedPolicyControls() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[isAdvancedConfigOpen, setIsAdvancedConfigOpen\]/);
  assert.match(source, /data-ripple-automation-advanced-config/);
  assert.match(source, /t\("automations\.advancedConfig"\)/);
  assert.match(source, /value=\{cwd\}/);
  assert.match(source, /value=\{maxRuntimeSeconds\}/);
  assert.match(source, /value=\{missedRunPolicy\}/);
  assert.match(source, /value=\{overlapPolicy\}/);
  assert.match(source, /value=\{failurePolicy\}/);
  assert.match(source, /missed_run_policy:\s*missedRunPolicy/);
  assert.match(source, /overlap_policy:\s*overlapPolicy/);
  assert.match(source, /failure_policy:\s*failurePolicy/);
}

function testAutomationCardUsesCompactResponsiveLayout() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_PAGE_BACKGROUND_CLASS/);
  assert.match(source, /WORKBENCH_MOBILE_ICON_BUTTON_CLASS/);
  assert.match(source, /className=\{`\$\{WORKBENCH_MOBILE_ICON_BUTTON_CLASS\} shrink-0/);
  assert.doesNotMatch(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.doesNotMatch(source, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(source, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
  assert.match(source, /MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS/);
  assert.match(source, /LUCIDE_NAV_STROKE_WIDTH/);
  assert.doesNotMatch(source, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /circle_at_16%_0%/);
  assert.match(
    source,
    /data-ripple-automation-card-main[\s\S]*className="overflow-hidden rounded-xl border border-\[#DEE0E3\] bg-white px-3 py-2 shadow-\[0_1px_2px_rgba\(31,35,41,0\.04\)\] sm:px-4 sm:py-2\.5 xl:px-5"/
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
    /data-ripple-automation-latest-run[\s\S]*rounded-lg border border-\[#EFF0F1\] bg-\[#F8F9FA\] px-2 py-1\.5/
  );
  assert.match(source, /data-ripple-automation-latest-run[\s\S]*grid min-w-0 gap-1\.5/);
  assert.doesNotMatch(source, /const latestRunId/);
  assert.doesNotMatch(source, /\{latestRunId \|\| "No run"\}/);
  assert.match(source, /latestRunAt[\s\S]*formatDate\(latestRunAt, locale, t\)/);
  assert.match(source, /data-ripple-automation-mobile-primary-actions/);
  assert.match(source, /data-ripple-automation-actions[\s\S]*mt-2 hidden grid-cols-3 gap-1\.5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,120}pl-8/);
  assert.match(source, /md:grid-cols-5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,220}overflow-x-auto/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,180}border-t/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*w-full/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*TYPOGRAPHY_META_MEDIUM_CLASS/);
  assert.match(source, /const runActionButtonClass =[\s\S]*h-8/);
}

function testAutomationLatestRunSummaryDoesNotDuplicateOutputActions() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /hasRunOutput\(latestRun\)/);
  assert.doesNotMatch(source, /pendingRunActionId === `\$\{latestRun\.job_id\}:view`/);
  assert.doesNotMatch(source, /pendingRunActionId === `\$\{latestRun\.job_id\}:download`/);
  assert.match(source, /data-ripple-automation-run-row[\s\S]*handleViewOutput\(run, schedule\.title\)/);
  assert.match(source, /data-ripple-automation-run-row[\s\S]*handleDownloadOutput\(run\)/);
  assert.match(source, /t\("automations\.runShort"\)/);
  assert.match(source, /t\("automations\.historyShort"\)/);
}

function testAutomationHeaderActionsMatchSkillsPageStyle() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const skillsSource = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const primaryButtonClass =
    source.match(/const AUTOMATION_PRIMARY_ACTION_BUTTON_CLASS = `([^`]+)`;/)?.[1] || "";
  const skillCreateButtonClass =
    skillsSource.match(/const SKILL_CREATE_ACTION_BUTTON_CLASS = `([^`]+)`;/)?.[1] || "";

  assert.match(source, /CalendarPlus/);
  assert.doesNotMatch(source, /<Plus size=\{15\}/);
  assert.match(source, /const AUTOMATION_PRIMARY_ACTION_BUTTON_CLASS = `inline-flex h-11/);
  assert.match(primaryButtonClass, /rounded-xl/);
  assert.doesNotMatch(primaryButtonClass, /rounded-full/);
  assert.match(primaryButtonClass, /lg:h-10 lg:w-auto lg:gap-1\.5 lg:px-3/);
  assert.match(source, /className=\{AUTOMATION_PRIMARY_ACTION_BUTTON_CLASS\}/);
  assert.match(skillCreateButtonClass, /rounded-xl/);
  assert.match(skillCreateButtonClass, /bg-\[#1456F0\]/);
  assert.match(skillCreateButtonClass, /text-white/);
  assert.doesNotMatch(skillCreateButtonClass, /text-\[#646A73\]/);
  assert.match(
    source,
    /className=\{`\$\{WORKBENCH_MOBILE_ICON_BUTTON_CLASS\} shrink-0[\s\S]*lg:h-10 lg:w-auto lg:gap-1\.5[\s\S]*lg:px-3/
  );
  assert.match(source, /<span className="hidden lg:inline">\{t\("automations\.refresh"\)\}<\/span>/);
}

function testAutomationsPageUsesSolidWorkbenchSurfaces() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_(SECTION|SURFACE|PRIMARY_BUTTON|SECONDARY_BUTTON|STATUS|FIELD|MENU)/);
  assert.doesNotMatch(source, /bg-white\/7[02468].*backdrop-blur-xl/);
  assert.doesNotMatch(source, /shadow-\[0_18px_44px/);
  assert.doesNotMatch(source, /backdrop-blur-xl/);
}

function testAutomationCardUsesDesktopRowLayout() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /data-ripple-automation-card-main[\s\S]*className="overflow-hidden rounded-xl border border-\[#DEE0E3\] bg-white px-3 py-2 shadow-\[0_1px_2px_rgba\(31,35,41,0\.04\)\] sm:px-4 sm:py-2\.5 xl:px-5"/
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
  assert.match(source, /data-ripple-automation-actions[\s\S]*hidden grid-cols-3[\s\S]*md:grid/);
  assert.match(source, /data-ripple-automation-actions[\s\S]*md:grid-cols-5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,160}sm:flex/);
}

function testAutomationsPageUsesInlineMobileActionsWithoutOverflowSheet() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-form-sheet/);
  assert.match(
    source,
    /data-ripple-automation-mobile-primary-actions[\s\S]*className="mt-2 grid grid-cols-5/
  );
  assert.match(source, /data-ripple-automation-mobile-primary-actions[\s\S]*beginEditSchedule\(schedule\)/);
  assert.match(source, /data-ripple-automation-mobile-primary-actions[\s\S]*"toggle", schedule\.enabled/);
  assert.match(source, /data-ripple-automation-mobile-primary-actions[\s\S]*"delete"/);
  assert.doesNotMatch(source, /import MobileActionSheet from "\.\/MobileActionSheet"/);
  assert.doesNotMatch(source, /data-ripple-automation-more-sheet/);
  assert.doesNotMatch(source, /activeScheduleMenuId/);
  assert.doesNotMatch(source, /MoreHorizontal/);
  assert.match(source, /<ArrowLeft size=\{16\}/);
  assert.doesNotMatch(source, /ArrowBigLeft/);
}

function testAutomationRunHistoryUsesReadableRows() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-run-history/);
  assert.match(source, /data-ripple-automation-run-row/);
  assert.match(source, /divide-y divide-\[#EFF0F1\]/);
  assert.match(source, /max-h-44 overflow-y-auto/);
  assert.match(source, /data-ripple-automation-run-row[\s\S]*py-1\.5/);
  assert.match(source, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(source, /data-ripple-automation-run-row[\s\S]*truncate font-\[family-name:var\(--font-mono\)\]/);
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
testNewAutomationOpensChatInsteadOfCreateForm();
testExistingAutomationsCanBeEdited();
testAutomationRunResultsAreDiscoverable();
testRunningAutomationRunsDoNotOfferOutputActions();
testCompletedScheduleRunsDoNotSurfaceToolStderrAsErrors();
testAutomationStaticCopyUsesEnglish();
testAutomationCardUsesSeparatedLayoutRegions();
testAutomationConfigExposesAdvancedPolicyControls();
testAutomationCardUsesCompactResponsiveLayout();
testAutomationLatestRunSummaryDoesNotDuplicateOutputActions();
testAutomationHeaderActionsMatchSkillsPageStyle();
testAutomationsPageUsesSolidWorkbenchSurfaces();
testAutomationCardUsesDesktopRowLayout();
testAutomationsPageUsesInlineMobileActionsWithoutOverflowSheet();
testAutomationRunHistoryUsesReadableRows();
testAutomationsPageRendersChineseChrome();

console.log("automations page tests passed");
