import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import SkillsPage, {
  resolveSkillsCategoryBackSwipeRelease,
  shouldCancelSkillsCategoryBackSwipe,
  shouldClaimSkillsCategoryBackSwipe,
  shouldGuardSkillsCategoryBackSwipeScroll,
  shouldReleaseSkillsCategoryBackSwipeScrollGuard,
} from "./SkillsPage";

const noop = () => {};

function renderSkillsPage(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <SkillsPage userId="default" onOpenChat={noop} />
    </I18nProvider>
  );
}

function testSkillsPageRendersUserFacingChrome() {
  const html = renderSkillsPage();

  assert.match(html, /sm:hidden[^>]*>Skills</);
  assert.match(html, /hidden sm:inline[^>]*>Skills</);
  assert.match(html, /No skills yet/);
  assert.match(html, /aria-label="Refresh"/);
  assert.match(html, /data-ripple-skills-page="true"/);
}

testSkillsPageRendersUserFacingChrome();

function testSkillsPageUsesSkillApisAndHidesInternalRuntimeDetails() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchSkills/);
  assert.match(source, /updateSkill/);
  assert.match(source, /validateSkill/);
  assert.match(source, /deleteSkill/);
  assert.match(source, /onOpenChat/);
  assert.match(source, /data-ripple-skill-card="true"/);
  assert.doesNotMatch(source, /data-ripple-skill-create-form="true"/);
  assert.doesNotMatch(source, /runtime_capability/);
  assert.doesNotMatch(source, /Runtime Capabilities/);
  assert.doesNotMatch(source, /frontmatter/i);
  assert.doesNotMatch(source, /requires\.bins/);
  assert.doesNotMatch(source, /prompt injection/i);
}

testSkillsPageUsesSkillApisAndHidesInternalRuntimeDetails();

function testSkillsPageRefreshTimestampDoesNotRetriggerInitialLoad() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /lastRefreshAtRef/);
  assert.doesNotMatch(source, /const \[lastRefreshAt/);
  assert.doesNotMatch(source, /\[lastRefreshAt,\s*t\]/);
}

testSkillsPageRefreshTimestampDoesNotRetriggerInitialLoad();

function testSkillsPageCachesSnapshotsAcrossTabMounts() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /skillSnapshotCache/);
  assert.match(source, /skillSnapshotInflight/);
  assert.match(source, /cachedSkillSnapshot\(userId\)/);
  assert.match(source, /hasSkillSnapshot\(userId\)/);
  assert.match(source, /background: hasSkillSnapshot\(userId\)/);
  assert.doesNotMatch(source, /void loadSkills\(true\);/);
}

testSkillsPageCachesSnapshotsAcrossTabMounts();

function testSkillsPageUsesCategoryIndexInsteadOfStatusSections() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const skillDescriptionSource = readFileSync(
    new URL("./SkillDescriptionMarkdown.tsx", import.meta.url),
    "utf8"
  );
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /buildSkillCategories/);
  assert.match(source, /display_source/);
  assert.match(source, /data-ripple-skill-category-index="true"/);
  assert.match(source, /data-ripple-skill-category-row="true"/);
  assert.match(source, /data-ripple-skill-category-detail="true"/);
  assert.match(source, /data-ripple-skill-category-logo="true"/);
  assert.match(source, /categorySummary\(category,/);
  assert.match(i18n, /categoryMine: "我创建的"/);
  assert.match(i18n, /categoryConnectedServices: "需要授权"/);
  assert.match(i18n, /categoryGeneral: "通用能力"/);
  assert.match(i18n, /categoryMine: "Mine"/);
  assert.match(i18n, /categoryConnectedServices: "Needs authorization"/);
  assert.match(i18n, /categoryGeneral: "General skills"/);
  assert.match(i18n, /categorySummaries:/);
  assert.match(source, /SkillDescriptionMarkdown/);
  assert.match(source, /expandedDescriptionSkillId/);
  assert.match(source, /setExpandedDescriptionSkillId/);
  assert.match(source, /clamp=\{!isDescriptionExpanded\}/);
  assert.match(skillDescriptionSource, /line-clamp-2/);
  assert.match(source, /id: "connected_services"/);
  assert.match(source, /sourceId: "system"/);
  assert.doesNotMatch(source, /data-ripple-skill-source-section="true"/);
  assert.doesNotMatch(source, /shouldDefaultOpenGroup/);
  assert.doesNotMatch(source, /skills\.noConnectionNeeded/);
}

testSkillsPageUsesCategoryIndexInsteadOfStatusSections();

function testSkillsPageMergesConnectorManagementIntoCategories() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchCapabilities/);
  assert.match(source, /fetchGogcliAccounts/);
  assert.match(source, /disconnectConnector/);
  assert.match(source, /data-ripple-skill-connector-panel="true"/);
  assert.match(source, /data-ripple-skill-connector-account="true"/);
  assert.match(source, /type: "connector\.auth\.start"/);
  assert.match(source, /source: "skills_page"/);
  assert.doesNotMatch(source, /window\.open\(/);
  assert.doesNotMatch(source, /qrcodeImageUrl/);
}

testSkillsPageMergesConnectorManagementIntoCategories();

function testSkillsPageKeepsStatusAsFilterOnly() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /statusFilter/);
  assert.match(source, /data-ripple-skill-filter-control="true"/);
  assert.match(i18n, /filter: "筛选"/);
  assert.match(i18n, /filter: "Filter"/);
  assert.doesNotMatch(source, /data-ripple-skill-source-section="true"/);
  assert.doesNotMatch(source, /data-ripple-skill-connector-group="true"/);
}

testSkillsPageKeepsStatusAsFilterOnly();

function testSkillsPageDoesNotUseGlobalBlueFocusOutline() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const globalCss = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");

  assert.match(source, /type="search"/);
  assert.doesNotMatch(globalCss, /:focus-visible\s*\{/);
  assert.doesNotMatch(globalCss, /outline:\s*2px solid var\(--ripple-brand\)/);
}

testSkillsPageDoesNotUseGlobalBlueFocusOutline();

function testSkillsPageUsesCompactSkillRowsInCategoryDetail() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /ArrowLeft/);
  assert.match(source, /data-ripple-skill-status-icon="true"/);
  assert.doesNotMatch(source, /ArrowBigLeft/);
  assert.doesNotMatch(source, /<details/);
  assert.doesNotMatch(source, /<summary/);
  assert.doesNotMatch(source, /group-open\/skill/);
  assert.doesNotMatch(source, /skills\.builtIn/);
  assert.doesNotMatch(source, /skills\.readOnly/);
  assert.doesNotMatch(source, /t\(skillStatusKey\(status\)\)/);
}

testSkillsPageUsesCompactSkillRowsInCategoryDetail();

function testSkillsPageAnimatesCategoryDrillInBothLayouts() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /import \{ AnimatePresence, animate, motion, useMotionValue, useReducedMotion \} from "framer-motion"/
  );
  assert.match(source, /categoryTransitionDirection/);
  assert.match(source, /data-ripple-skill-category-motion-stage/);
  assert.match(source, /key=\{selectedCategory \? `detail:\$\{selectedCategory\.id\}` : "index"\}/);
  assert.match(source, /custom=\{categoryTransitionDirection\}/);
  assert.match(source, /reducedMobilePageVariants/);
  assert.match(source, /mobilePageVariants/);
}

testSkillsPageAnimatesCategoryDrillInBothLayouts();

function testSkillsCategoryDetailSupportsSwipeBackGesture() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.equal(
    shouldGuardSkillsCategoryBackSwipeScroll({
      deltaX: 6,
      deltaY: 5,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldGuardSkillsCategoryBackSwipeScroll({
      startX: 4,
      deltaX: 4,
      deltaY: 5,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      startX: 4,
      deltaX: 4,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      deltaX: 10,
      deltaY: 0,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      deltaX: 24,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      deltaX: 24,
      deltaY: 24,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldCancelSkillsCategoryBackSwipe({
      deltaX: 4,
      deltaY: 22,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldCancelSkillsCategoryBackSwipe({
      deltaX: 14,
      deltaY: 20,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    resolveSkillsCategoryBackSwipeRelease({
      x: 72,
      velocityX: 0,
      viewportWidth: 390,
    }).shouldCloseCategory,
    true
  );
  assert.equal(
    resolveSkillsCategoryBackSwipeRelease({
      x: 24,
      velocityX: 260,
      viewportWidth: 390,
    }).shouldCloseCategory,
    true
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      deltaX: 40,
      deltaY: 0,
      viewportWidth: 1280,
    }),
    false
  );

  assert.match(source, /data-ripple-skill-category-swipe-stack="true"/);
  assert.match(source, /data-ripple-skill-category-index-underlay="true"/);
  assert.match(source, /data-ripple-skill-category-swipe-sheet="true"/);
  assert.match(source, /onTouchMoveCapture=\{handleCategorySwipeTouchMoveCapture\}/);
  assert.match(source, /onPointerMove=\{handleCategorySwipePointerMove\}/);
  assert.match(source, /closeCategoryWithSwipeCommit/);
}

testSkillsCategoryDetailSupportsSwipeBackGesture();

function testSkillsCategorySwipeUsesSharedMotionPrimitive() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /shouldClaimMobileSwipeBack/);
  assert.match(source, /shouldGuardMobileSwipeBackScroll/);
  assert.match(source, /shouldCancelMobileSwipeBack/);
  assert.match(source, /shouldReleaseMobileSwipeBackScrollGuard/);
  assert.match(source, /resolveMobileSwipeBackRelease/);
  assert.doesNotMatch(source, /SKILLS_CATEGORY_BACK_SWIPE_CLAIM_DISTANCE_PX/);
  assert.doesNotMatch(source, /SKILLS_CATEGORY_BACK_SWIPE_FAST_COMMIT_VELOCITY_PX/);
}

function testSkillsCategoryGuardedScrollCanReleaseBackToVerticalIntent() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.equal(
    shouldReleaseSkillsCategoryBackSwipeScrollGuard({
      deltaX: 8,
      deltaY: 26,
      viewportWidth: 390,
    }),
    true
  );
  assert.match(source, /shouldReleaseSkillsCategoryBackSwipeScrollGuard/);
  assert.match(source, /releaseCategorySwipeScrollLock\(\)/);
}

function testSkillsCategoryTransitionDoesNotWaitThroughBlankFrame() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /mobilePageSwitchTransition/);
  assert.doesNotMatch(
    source,
    /<AnimatePresence mode="wait" initial=\{false\} custom=\{categoryTransitionDirection\}>/
  );
}

testSkillsCategorySwipeUsesSharedMotionPrimitive();
testSkillsCategoryGuardedScrollCanReleaseBackToVerticalIntent();
testSkillsCategoryTransitionDoesNotWaitThroughBlankFrame();

function testSkillsCategoryDetailIsFullMobileSubpage() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-skill-category-index-page="true"/);
  assert.match(source, /data-ripple-skill-category-detail-page="true"/);
  assert.match(source, /renderCategoryIndexPage/);
  assert.match(source, /renderCategoryDetailPage/);
  assert.doesNotMatch(source, /\{renderSearchAndFilters\(\)\}\s*<AnimatePresence/);
}

testSkillsCategoryDetailIsFullMobileSubpage();

function testSkillsPageUsesPlainGeneralGroupLabels() {
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(i18n, /groupCustom: "自定义"/);
  assert.match(i18n, /groupGeneral: "通用"/);
  assert.match(i18n, /groupCustom: "Custom"/);
  assert.match(i18n, /groupGeneral: "General"/);
  assert.doesNotMatch(i18n, /group(?:Custom|General): "[^"]*\//);
  assert.doesNotMatch(i18n, /groupGeneral: "[^"]*(?:无连接器|no connector)/);
}

testSkillsPageUsesPlainGeneralGroupLabels();

function testSkillsPageRoutesManagementThroughSessions() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /onOpenSessionAction/);
  assert.match(source, /connectorNameForCategory/);
  assert.match(source, /type: "connector\.auth\.start"/);
  assert.match(source, /source: "skills_page"/);
  assert.match(source, /autoSend: true/);
  assert.doesNotMatch(source, /startConnectorAuth/);
}

testSkillsPageRoutesManagementThroughSessions();

function testSkillsPageCreateSkillStartsFreshSession() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /newSession: true/);
  assert.match(
    source,
    /onOpenChat\?\.\(t\("skills\.createChatPrompt"\), \{ autoSend: true, newSession: true \}\)/
  );
  assert.match(i18n, /automatically checked/);
  assert.match(i18n, /自动检查/);
}

testSkillsPageCreateSkillStartsFreshSession();

function testSkillsPageEditSkillOpensScopedChatPrompt() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /openEditSkillChat/);
  assert.match(source, /skill\.can_edit/);
  assert.match(source, /skills\.editChatPrompt/);
  assert.match(source, /id: skill\.id/);
  assert.match(source, /directory: skillEditDirectory\(skill\)/);
  assert.doesNotMatch(source, /path: skill\.path/);
  assert.doesNotMatch(
    source,
    /type="button"\n\s+disabled\n\s+className=\{`\$\{SKILL_ACTION_BUTTON_CLASS\} text/
  );
  assert.match(i18n, /workspace-relative directory/);
  assert.match(i18n, /workspace 相对目录/);
  assert.doesNotMatch(i18n, /path: \{path\}/);
  assert.doesNotMatch(i18n, /\/home\/|\.ripple\/sandboxes/);
}

testSkillsPageEditSkillOpensScopedChatPrompt();

function testSkillsPageSupportsNeedsConfirmationStatus() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /needs_confirmation/);
  assert.match(i18n, /needsConfirmation: "需要确认"/);
  assert.match(i18n, /needsConfirmation: "Needs confirmation"/);
}

testSkillsPageSupportsNeedsConfirmationStatus();

function testSkillsPageUsesValidationLanguageInsteadOfTestLanguage() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /skills\.validate/);
  assert.doesNotMatch(source, /skills\.test/);
  assert.match(i18n, /validate: "检查"/);
  assert.match(i18n, /validated: "检查完成"/);
  assert.match(i18n, /validate: "Validate"/);
  assert.match(i18n, /validated: "Validation complete"/);
  assert.doesNotMatch(i18n, /test: "Test"/);
  assert.doesNotMatch(i18n, /tested: "Test completed"/);
}

testSkillsPageUsesValidationLanguageInsteadOfTestLanguage();

function testSkillsPageUsesFeishuInspiredVisualLanguage() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /#1456F0/);
  assert.match(source, /#1F2329/);
  assert.match(source, /#646A73/);
  assert.match(source, /#8F959E/);
  assert.match(source, /#DEE0E3/);
  assert.match(source, /TYPOGRAPHY_BODY_MEDIUM_CLASS/);
}

testSkillsPageUsesFeishuInspiredVisualLanguage();

function testSkillsPageRendersChineseChrome() {
  const html = renderSkillsPage("zh-CN");

  assert.match(html, /sm:hidden[^>]*>能力</);
  assert.match(html, />暂无能力/);
  assert.match(html, /aria-label="刷新"/);
}

testSkillsPageRendersChineseChrome();

console.log("skills page tests passed");
