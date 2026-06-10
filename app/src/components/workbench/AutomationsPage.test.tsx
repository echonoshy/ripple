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
        userId="default"
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

  assert.match(
    source,
    /onOpenChat\?: \(prompt: string, options\?: \{ autoSend\?: boolean; newSession\?: boolean \}\) => void/
  );
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
  assert.match(source, /data-ripple-automation-mobile-summary-card/);
  assert.match(source, /data-ripple-automation-mobile-detail-actions/);
  assert.doesNotMatch(source, /data-ripple-automation-mobile-primary-actions/);
  assert.match(source, /data-ripple-automation-actions[\s\S]*mt-2 hidden grid-cols-3 gap-1\.5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,120}pl-8/);
  assert.match(source, /md:grid-cols-5/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,220}overflow-x-auto/);
  assert.doesNotMatch(source, /data-ripple-automation-actions[\s\S]{0,180}border-t/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*w-full/);
  assert.match(source, /const automationActionButtonClass =[\s\S]*TYPOGRAPHY_META_MEDIUM_CLASS/);
  assert.match(source, /const mobileRunActionButtonClass =[\s\S]*h-8/);
}

function testAutomationLatestRunSummaryDoesNotDuplicateOutputActions() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /hasRunOutput\(latestRun\)/);
  assert.doesNotMatch(source, /pendingRunActionId === `\$\{latestRun\.job_id\}:view`/);
  assert.doesNotMatch(source, /pendingRunActionId === `\$\{latestRun\.job_id\}:download`/);
  assert.match(
    source,
    /data-ripple-automation-run-row[\s\S]*handleViewOutput\(run, schedule\.title\)/
  );
  assert.match(source, /data-ripple-automation-run-row[\s\S]*handleDownloadOutput\(run\)/);
  assert.match(source, /t\("automations\.runNow"\)/);
  assert.match(source, /t\("automations\.runHistory"\)/);
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
  assert.match(
    source,
    /<span className="hidden lg:inline">\{t\("automations\.refresh"\)\}<\/span>/
  );
}

function testAutomationsPageUsesSolidWorkbenchSurfaces() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /WORKBENCH_(SECTION|SURFACE|PRIMARY_BUTTON|SECONDARY_BUTTON|STATUS|FIELD|MENU)/
  );
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
  assert.match(source, /data-ripple-automation-mobile-summary-card/);
  assert.match(source, /data-ripple-automation-detail-page="true"/);
  assert.match(source, /data-ripple-automation-mobile-detail-actions/);
  assert.match(source, /data-ripple-automation-mobile-detail-actions[\s\S]*beginEditSchedule\(schedule\)/);
  assert.match(
    source,
    /data-ripple-automation-mobile-detail-actions[\s\S]*"toggle", schedule\.enabled/
  );
  assert.match(source, /data-ripple-automation-mobile-detail-actions[\s\S]*"delete"/);
  assert.doesNotMatch(source, /import MobileActionSheet from "\.\/MobileActionSheet"/);
  assert.doesNotMatch(source, /data-ripple-automation-more-sheet/);
  assert.doesNotMatch(source, /activeScheduleMenuId/);
  assert.doesNotMatch(source, /MoreHorizontal/);
  assert.match(source, /<ArrowLeft size=\{16\}/);
  assert.doesNotMatch(source, /ArrowBigLeft/);
}

function testAutomationEditUsesMobileDetailPageAndCompactText() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /data-ripple-automation-edit-page="true"[\s\S]*<MobilePageHeader[\s\S]*title=\{t\("automations\.edit"\)\}[\s\S]*onBack=\{closeForm\}/
  );
  assert.match(source, /data-ripple-automation-form-page/);
  assert.match(source, /data-ripple-automation-form-actions/);
  assert.match(
    source,
    /data-ripple-automation-form-page[\s\S]*auto-rows-max content-start/
  );
  assert.match(
    source,
    /className="fixed inset-x-0 top-0 z-40 flex h-dvh min-h-0 flex-col overflow-hidden/
  );
  assert.match(
    source,
    /data-ripple-automation-form-actions[\s\S]*className="relative z-10 flex shrink-0/
  );
  assert.doesNotMatch(source, /data-ripple-automation-form-backdrop/);
  assert.doesNotMatch(source, /max-md:fixed/);
  assert.match(source, /const automationFieldLabelClass =[\s\S]*text-\[12px\]/);
  assert.match(source, /const automationFieldControlClass =[\s\S]*text-\[15px\]/);
  assert.match(source, /const automationMonoFieldControlClass =[\s\S]*text-\[15px\]/);
  assert.match(source, /const automationTextareaClass =[\s\S]*text-\[15px\]/);
}

function testAutomationAdvancedConfigUsesDisclosureSection() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const advancedSection =
    source.match(
      /data-ripple-automation-advanced-section[\s\S]*?data-ripple-automation-advanced-config[\s\S]*?automations\.cwd/
    )?.[0] || "";

  assert.match(advancedSection, /data-ripple-automation-advanced-trigger/);
  assert.match(advancedSection, /aria-expanded=\{isAdvancedConfigOpen\}/);
  assert.match(advancedSection, /flex h-11 w-full items-center justify-between/);
  assert.match(advancedSection, /overflow-hidden rounded-xl border border-\[#DEE0E3\] bg-white/);
  assert.match(advancedSection, /border-t border-\[#EFF0F1\] bg-\[#F8F9FA\] p-3/);
  assert.doesNotMatch(advancedSection, /inline-flex h-9 w-fit items-center gap-1 rounded-lg/);
}

function testMobileAutomationEditReturnsToDetailPage() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const mobileActions =
    source.match(
      /data-ripple-automation-mobile-detail-actions[\s\S]*?\{isExpanded \?/
    )?.[0] || "";
  const closeFormBlock =
    source.match(/const closeForm = useCallback\([\s\S]*?\}, \[resetForm\]\);/)?.[0] || "";
  const submitSuccessBlock =
    source.match(/await updateSchedule\(editingScheduleId[\s\S]*?await loadSchedules/)?.[0] || "";

  assert.match(mobileActions, /beginEditSchedule\(schedule\);/);
  assert.doesNotMatch(mobileActions, /closeScheduleDetail\(\);/);
  assert.doesNotMatch(closeFormBlock, /setSelectedScheduleId\(null\)|closeScheduleDetail/);
  assert.doesNotMatch(submitSuccessBlock, /setSelectedScheduleId\(null\)|closeScheduleDetail/);
}

function testAutomationsMobileActionsStaySingleLineOnNarrowScreens() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-mobile-detail-actions/);
  assert.match(source, /data-ripple-automation-mobile-detail-actions[\s\S]*grid grid-cols-2/);
  assert.doesNotMatch(source, /grid-cols-5 gap-1 md:hidden/);
  assert.match(
    source,
    /const mobileAutomationActionButtonClass =[\s\S]*h-11[\s\S]*TYPOGRAPHY_META_MEDIUM_CLASS/
  );
  assert.doesNotMatch(source, /const mobileAutomationActionButtonClass =[\s\S]*text-\[10px\]/);
  assert.match(source, /const mobileAutomationActionButtonClass =[\s\S]*px-2\.5/);
  assert.match(source, /data-ripple-ignore-automations-swipe/);
  assert.match(source, /className=\{mobileAutomationActionButtonClass\}/);
  assert.match(source, /className=\{`\$\{mobileAutomationDeleteButtonClass\}/);
}

function testMobileAutomationDeleteConfirmationCanBeCancelled() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const mobileActions =
    source.match(
      /data-ripple-automation-mobile-detail-actions[\s\S]*?\{isExpanded \?/
    )?.[0] || "";

  assert.match(source, /const isConfirmingDelete = confirmDeleteId === schedule\.schedule_id;/);
  assert.match(mobileActions, /isConfirmingDelete \? \(/);
  assert.match(mobileActions, /onClick=\{\(\) => setConfirmDeleteId\(null\)\}/);
  assert.match(mobileActions, /aria-label=\{t\("automations\.cancelDeleteAutomation"\)\}/);
  assert.match(mobileActions, /<span>\{t\("automations\.cancel"\)\}<\/span>/);
  assert.match(mobileActions, /isConfirmingDelete[\s\S]*t\("automations\.confirm"\)/);
  assert.doesNotMatch(
    mobileActions,
    /data-ripple-automation-mobile-detail-actions[\s\S]{0,120}grid-cols-6/
  );
}

function testMobileAutomationDetailPutsRunHistoryAtBottom() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const mobileActions =
    source.match(
      /data-ripple-automation-mobile-detail-actions[\s\S]*?\{isExpanded \?/
    )?.[0] || "";

  const runNowIndex = mobileActions.indexOf('aria-label={t("automations.runAutomationNow")}');
  const deleteIndex = mobileActions.indexOf('aria-label={t("automations.deleteAutomation")}');
  const editIndex = mobileActions.indexOf('aria-label={t("automations.editAutomation")}');
  const pauseIndex = mobileActions.indexOf('t("automations.pauseAutomation")');
  const runHistoryIndex = mobileActions.indexOf('aria-label={t("automations.toggleRunHistory")}');

  assert.ok(runNowIndex >= 0);
  assert.ok(deleteIndex > runNowIndex);
  assert.ok(editIndex > deleteIndex);
  assert.ok(pauseIndex > editIndex);
  assert.ok(runHistoryIndex > pauseIndex);
  assert.match(
    mobileActions,
    /aria-label=\{t\("automations\.toggleRunHistory"\)\}[\s\S]*className=\{`\$\{mobileAutomationActionButtonClass\} col-span-2`\}/
  );
}

function testMobileAutomationDeleteConfirmationKeepsHistoryLast() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const mobileActions =
    source.match(
      /data-ripple-automation-mobile-detail-actions[\s\S]*?\{isExpanded \?/
    )?.[0] || "";

  const confirmIndex = mobileActions.indexOf('<span>{t("automations.confirm")}</span>');
  const editIndex = mobileActions.indexOf('aria-label={t("automations.editAutomation")}');
  const cancelIndex = mobileActions.indexOf(
    'aria-label={t("automations.cancelDeleteAutomation")}'
  );
  const runHistoryIndex = mobileActions.indexOf('aria-label={t("automations.toggleRunHistory")}');

  assert.ok(confirmIndex >= 0);
  assert.ok(editIndex > confirmIndex);
  assert.ok(cancelIndex > editIndex);
  assert.ok(runHistoryIndex > cancelIndex);
}

function testAutomationsMobileDetailUsesSkillsStyleSwipeBack() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const swipeSheetBlock =
    source.match(
      /<motion\.div[\s\S]*?data-ripple-automation-detail-swipe-sheet="true"[\s\S]*?<\/motion\.div>/
    )?.[0] || "";

  assert.match(
    source,
    /import \{ AnimatePresence, animate, motion, useMotionValue, useReducedMotion \} from "framer-motion"/
  );
  assert.match(source, /import MobilePageHeader from "\.\/MobilePageHeader"/);
  assert.match(source, /mobilePageVariants/);
  assert.match(source, /reducedMobilePageVariants/);
  assert.match(source, /mobileStackCommitTransition/);
  assert.doesNotMatch(source, /resolveMobileStackExitTarget\(dragState\.viewportWidth\)/);
  assert.match(source, /animateDetailSwipeTo\(\s*dragState\.viewportWidth,/);
  assert.doesNotMatch(swipeSheetBlock, /shadow-\[-18px_0_44px_rgba\(31,35,41,0\.18\)\]/);
  assert.match(swipeSheetBlock, /border-l/);
  assert.match(
    swipeSheetBlock,
    /isDetailSwipeActive \? "border-\[#D0D3D6\]" : "border-transparent"/
  );
  assert.match(source, /resolveMobileSwipeBackRelease/);
  assert.match(source, /data-ripple-automation-detail-swipe-stack="true"/);
  assert.match(source, /data-ripple-automation-detail-motion-stage="true"/);
  assert.match(swipeSheetBlock, /style=\{\{ x: detailSwipeX \}\}/);
  assert.match(swipeSheetBlock, /onPointerDownCapture=\{handleDetailSwipePointerDown\}/);
  assert.match(swipeSheetBlock, /onPointerMoveCapture=\{handleDetailSwipePointerMove\}/);
  assert.match(swipeSheetBlock, /onPointerUpCapture=\{handleDetailSwipePointerUp\}/);
  assert.match(swipeSheetBlock, /onClickCapture=\{handleDetailSwipeClickCapture\}/);
  assert.match(swipeSheetBlock, /onTouchStartCapture=\{handleDetailSwipeTouchStartCapture\}/);
  assert.match(swipeSheetBlock, /onTouchMoveCapture=\{handleDetailSwipeTouchMoveCapture\}/);
  assert.match(source, /shouldClaimAutomationBackSwipe/);
  assert.match(source, /shouldGuardAutomationBackSwipeScroll/);
  assert.match(source, /shouldCancelAutomationBackSwipe/);
  assert.match(source, /shouldReleaseAutomationBackSwipeScrollGuard/);
}

function testAutomationDetailUsesCompactMobileHeaderTitle() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const detailHeaderBlock =
    source.match(
      /<MobilePageHeader[\s\S]*?backLabel=\{t\("automations\.backToAutomations"\)\}[\s\S]*?\/>/
    )
      ?.[0] || "";
  const detailSwipeSheetBlock =
    source.match(
      /<motion\.div[\s\S]*?data-ripple-automation-detail-swipe-sheet="true"[\s\S]*?<\/motion\.div>/
    )?.[0] || "";

  assert.match(detailHeaderBlock, /title=\{schedule\.title\}/);
  assert.match(detailHeaderBlock, /titleClassName=\{MOBILE_DETAIL_HEADER_TITLE_CLASS\}/);
  assert.match(detailHeaderBlock, /className=\{MOBILE_DETAIL_PAGE_HEADER_CLASS\}/);
  assert.match(detailHeaderBlock, /backButtonVariant="ghost"/);
  assert.match(detailSwipeSheetBlock, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
}

function testAutomationRunHistoryUsesReadableRows() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-automation-run-history/);
  assert.match(source, /data-ripple-automation-run-row/);
  assert.match(source, /divide-y divide-\[#EFF0F1\]/);
  assert.match(source, /max-h-44 overflow-y-auto/);
  assert.match(source, /data-ripple-automation-run-row[\s\S]*py-1\.5/);
  assert.match(source, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(
    source,
    /data-ripple-automation-run-row[\s\S]*truncate font-\[family-name:var\(--font-mono\)\]/
  );
}

function testAutomationRunHistoryActionsUseCompactMobileText() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /const mobileRunActionButtonClass =[\s\S]*TYPOGRAPHY_MICRO_MEDIUM_CLASS/);
  assert.doesNotMatch(source, /const mobileRunActionButtonClass =[\s\S]*text-\[10px\]/);
  assert.match(source, /const mobileRunActionButtonClass =[\s\S]*px-1\.5/);
  assert.match(
    source,
    /data-ripple-automation-run-row[\s\S]*className=\{mobileRunActionButtonClass\}/
  );
  assert.match(
    source,
    /data-ripple-automation-run-row[\s\S]*className=\{`\$\{mobileRunActionButtonClass\}/
  );
}

function testAutomationRefreshesKeepExistingContentVisible() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const loadSchedules = useCallback\(async \(options: \{ background\?: boolean \} = \{\}\)/
  );
  assert.match(source, /if \(!options\.background\) setIsLoading\(true\)/);
  assert.match(source, /if \(!options\.background\) \{\s*setIsLoading\(false\);\s*\}/);
  assert.match(source, /void loadSchedules\(\{ background: true \}\)/);
  assert.match(source, /await loadSchedules\(\{ background: true \}\)/);
  assert.match(source, /onClick=\{\(\) => void loadSchedules\(\{ background: true \}\)\}/);
}

function testAutomationsPageCachesLoadedDataPerUserForTabReentry() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /userId: string;/);
  assert.match(source, /const automationsPageCacheByUserId: Record<string, AutomationsPageCache>/);
  assert.match(source, /const cachedAutomationsPageData = automationsPageCacheByUserId\[userId\]/);
  assert.match(
    source,
    /const \[schedules, setSchedules\] = useState<ScheduleInfo\[\]>\(\s*\(\) => cachedAutomationsPageData\?\.schedules \?\? \[\]\s*\)/
  );
  assert.match(source, /const \[isLoading, setIsLoading\] = useState\(\(\) => !cachedAutomationsPageData\)/);
  assert.match(
    source,
    /const \[runsBySchedule, setRunsBySchedule\] = useState<Record<string, AgentRunInfo\[\]>>\(\s*\(\) => cachedAutomationsPageData\?\.runsBySchedule \?\? \{\}\s*\)/
  );
  assert.match(source, /automationsPageCacheByUserId\[userId\] = \{/);
}

function testAutomationsPageOnlySilentlyRefreshesStaleCacheOnTabEntry() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");
  const mountRefreshBlock =
    source.match(/useEffect\(\(\) => \{[\s\S]*?isAutomationsPageCacheStale[\s\S]*?\}, \[[^\]]+\]\);/)?.[0] ||
    "";

  assert.match(source, /const AUTOMATIONS_PAGE_CACHE_STALE_MS = 60_000;/);
  assert.match(source, /function isAutomationsPageCacheStale\(userId: string/);
  assert.match(
    mountRefreshBlock,
    /if \(cachedAutomationsPageData && !isAutomationsPageCacheStale\(userId\)\) \{\s*return;\s*\}/
  );
  assert.match(
    mountRefreshBlock,
    /void loadSchedules\(\{ background: cachedAutomationsPageData !== null \}\)/
  );
  assert.doesNotMatch(mountRefreshBlock, /void loadSchedules\(\);\s*\}/);
}

function testAutomationsPageRendersChineseChrome() {
  const html = renderAutomationsPage("zh-CN");

  assert.match(html, />自动化</);
  assert.match(html, /aria-label="返回设置"/);
  assert.match(html, />新建</);
  assert.doesNotMatch(html, />暂无自动化</);
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
testAutomationEditUsesMobileDetailPageAndCompactText();
testAutomationAdvancedConfigUsesDisclosureSection();
testMobileAutomationEditReturnsToDetailPage();
testAutomationsMobileActionsStaySingleLineOnNarrowScreens();
testMobileAutomationDeleteConfirmationCanBeCancelled();
testMobileAutomationDetailPutsRunHistoryAtBottom();
testMobileAutomationDeleteConfirmationKeepsHistoryLast();
testAutomationsMobileDetailUsesSkillsStyleSwipeBack();
testAutomationDetailUsesCompactMobileHeaderTitle();
testAutomationRunHistoryUsesReadableRows();
testAutomationRunHistoryActionsUseCompactMobileText();
testAutomationRefreshesKeepExistingContentVisible();
testAutomationsPageCachesLoadedDataPerUserForTabReentry();
testAutomationsPageOnlySilentlyRefreshesStaleCacheOnTabEntry();
testAutomationsPageRendersChineseChrome();

console.log("automations page tests passed");
