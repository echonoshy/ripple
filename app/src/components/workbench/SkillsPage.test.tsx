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

function testSkillsCategoryDetailUsesSharedMobilePageHeader() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /import MobilePageHeader from "\.\/MobilePageHeader"/);
  assert.match(source, /<MobilePageHeader[\s\S]*title=\{categoryLabel\(category\)\}/);
  assert.match(source, /backLabel=\{t\("skills\.backToCategories"\)\}/);
  assert.match(source, /onBack=\{closeCategory\}/);
  assert.doesNotMatch(
    source,
    /<section data-ripple-skill-category-detail="true" className="space-y-2\.5">\s*<div className="flex items-start gap-2">/
  );
}

testSkillsCategoryDetailUsesSharedMobilePageHeader();

function testSkillsCategoryIndexUsesGroupedListRows() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const rowSource =
    source.match(/const renderCategoryRow =[\s\S]*?;\n\n {2}const renderCategoryIndex =/)?.[0] ||
    "";

  assert.match(source, /data-ripple-skill-category-group="true"/);
  assert.match(source, /divide-y divide-\[#EFF0F1\]/);
  assert.match(rowSource, /data-ripple-skill-category-row="true"/);
  assert.match(rowSource, /min-h-\[76px\]/);
  assert.doesNotMatch(rowSource, /WORKBENCH_SECTION_CLASS/);
  assert.doesNotMatch(rowSource, /grid-cols-\[auto_auto_minmax\(0,1fr\)\]/);
}

testSkillsCategoryIndexUsesGroupedListRows();

function testSkillsCategoryRowsUseRightChevronAndMobileStatusTag() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const rowSource =
    source.match(/const renderCategoryRow =[\s\S]*?;\n\n {2}const renderCategoryIndex =/)?.[0] ||
    "";

  const logoIndex = rowSource.indexOf("<CategoryLogo");
  const chevronIndex = rowSource.indexOf("<ChevronRight");
  assert.ok(logoIndex >= 0);
  assert.ok(chevronIndex > logoIndex);
  assert.match(rowSource, /data-ripple-skill-category-mobile-status="true"/);
  assert.match(rowSource, /sm:hidden/);
  assert.match(rowSource, /sm:inline-flex/);
}

testSkillsCategoryRowsUseRightChevronAndMobileStatusTag();

function testSkillsPageAnimatesCategoryDrillInBothLayouts() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /import \{ AnimatePresence, animate, motion, useMotionValue, useReducedMotion \} from "framer-motion"/
  );
  assert.match(source, /categoryTransitionDirection/);
  assert.match(source, /skipNextCategoryTransition/);
  assert.match(source, /data-ripple-skill-category-motion-stage/);
  assert.match(source, /key=\{selectedCategory \? `detail:\$\{selectedCategory\.id\}` : "index"\}/);
  assert.match(source, /custom=\{skipNextCategoryTransition \? 0 : categoryTransitionDirection\}/);
  assert.match(source, /reducedMobilePageVariants/);
  assert.match(source, /mobilePageVariants/);
}

testSkillsPageAnimatesCategoryDrillInBothLayouts();

function testSkillsCategoryDetailSupportsSwipeBackGesture() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const swipeSheetBlock =
    source.match(
      /<motion\.div[\s\S]*?data-ripple-skill-category-swipe-sheet="true"[\s\S]*?<\/motion\.div>/
    )?.[0] || "";
  const pageRootBlock =
    source.match(/<div\s+ref=\{skillsPageScrollRef\}[\s\S]*?>/)?.[0] || "";

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
      startX: 44,
      deltaX: 5,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      startX: 74,
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
    false
  );
  assert.equal(
    shouldClaimSkillsCategoryBackSwipe({
      deltaX: 28,
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
    true
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
  assert.match(swipeSheetBlock, /onPointerDownCapture=\{handleCategorySwipePointerDown\}/);
  assert.match(swipeSheetBlock, /onPointerMoveCapture=\{handleCategorySwipePointerMove\}/);
  assert.match(swipeSheetBlock, /onPointerUpCapture=\{handleCategorySwipePointerUp\}/);
  assert.match(swipeSheetBlock, /onClickCapture=\{handleCategorySwipeClickCapture\}/);
  assert.match(swipeSheetBlock, /onTouchStartCapture=\{handleCategorySwipeTouchStartCapture\}/);
  assert.match(swipeSheetBlock, /onTouchMoveCapture=\{handleCategorySwipeTouchMoveCapture\}/);
  assert.doesNotMatch(pageRootBlock, /onPointerDown=\{handleCategorySwipePointerDown\}/);
  assert.doesNotMatch(pageRootBlock, /onPointerDownCapture=\{handleCategorySwipePointerDown\}/);
  assert.doesNotMatch(pageRootBlock, /onTouchMoveCapture=\{handleCategorySwipeTouchMoveCapture\}/);
  assert.match(source, /closeCategoryWithSwipeCommit/);
}

testSkillsCategoryDetailSupportsSwipeBackGesture();

function testSkillsSwipeBackOnlyExcludesExplicitOptOutTargets() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const selectorBlock =
    source.match(/const SKILLS_CATEGORY_BACK_SWIPE_INTERACTIVE_SELECTOR =[\s\S]*?;/)?.[0] || "";

  assert.doesNotMatch(selectorBlock, /\bbutton\b/);
  assert.doesNotMatch(selectorBlock, /\ba,/);
  assert.doesNotMatch(selectorBlock, /\[role='button'\]/);
  assert.match(selectorBlock, /data-ripple-ignore-skills-swipe/);
  assert.match(source, /suppressNextCategorySwipeClickRef/);
}

testSkillsSwipeBackOnlyExcludesExplicitOptOutTargets();

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
  assert.match(source, /scrollElement\.scrollTop = startScrollTop/);
}

function testSkillsCategorySwipeUsesFullHeightScrollableSheetLikeSession() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const swipeStackBlock =
    source.match(
      /<div[\s\S]*?data-ripple-skill-category-swipe-stack="true"[\s\S]*?<motion\.div/
    )?.[0] || "";
  const swipeSheetBlock =
    source.match(
      /<motion\.div[\s\S]*?data-ripple-skill-category-swipe-sheet="true"[\s\S]*?<\/motion\.div>/
    )?.[0] || "";

  assert.match(swipeStackBlock, /h-full min-h-0/);
  assert.match(swipeStackBlock, /overflow-hidden/);
  assert.match(swipeSheetBlock, /absolute inset-0 z-10 h-full min-h-0/);
  assert.match(swipeSheetBlock, /overflow-y-auto/);
  assert.match(swipeSheetBlock, /data-ripple-skill-category-scroll="detail"/);
  assert.match(
    swipeSheetBlock,
    /isCategorySwipeActive \? "shadow-\[-18px_0_44px_rgba\(31,35,41,0\.18\)\]" : "shadow-none"/
  );
}

function testSkillsCategorySwipeCommitDoesNotJumpScrollAfterReturn() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const commitBlock =
    source.match(/const closeCategoryWithSwipeCommit = useCallback\(\(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0] ||
    "";

  assert.match(commitBlock, /setSelectedCategoryId\(null\)/);
  assert.match(commitBlock, /setSkipNextCategoryTransition\(true\)/);
  assert.doesNotMatch(commitBlock, /scrollSkillsPageToTop\(\)/);
  assert.match(source, /initial=\{skipNextCategoryTransition \? false : "enter"\}/);
  assert.match(source, /skipNextCategoryTransition \|\| reduceMotion/);
}

function testSkillsCategorySwipeCommitBypassesPresenceAnimation() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const staticContentBlock =
    source.match(
      /if \(shouldRenderStaticCategoryContent\) \{[\s\S]*?data-ripple-skill-category-static-stage="true"[\s\S]*?\{selectedCategory \? renderCategoryStage\(\) : renderCategoryIndexPage\(\)\}[\s\S]*?\}/
    )?.[0] || "";

  assert.match(source, /const shouldRenderStaticCategoryContent = skipNextCategoryTransition/);
  assert.match(staticContentBlock, /renderCategoryStage/);
  assert.match(staticContentBlock, /renderCategoryIndexPage/);
  assert.doesNotMatch(staticContentBlock, /AnimatePresence/);
}

function testSkillsCategoryTransitionDoesNotWaitOrKeepExitingPageInLayoutFlow() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /mobilePageSwitchTransition/);
  assert.match(
    source,
    /<AnimatePresence[\s\S]*?mode="popLayout"[\s\S]*?initial=\{false\}[\s\S]*?custom=\{skipNextCategoryTransition \? 0 : categoryTransitionDirection\}/
  );
  assert.doesNotMatch(
    source,
    /<AnimatePresence[\s\S]*?mode="wait"[\s\S]*?initial=\{false\}[\s\S]*?custom=\{skipNextCategoryTransition \? 0 : categoryTransitionDirection\}/
  );
}

testSkillsCategorySwipeUsesSharedMotionPrimitive();
testSkillsCategoryGuardedScrollCanReleaseBackToVerticalIntent();
testSkillsCategorySwipeUsesFullHeightScrollableSheetLikeSession();
testSkillsCategorySwipeCommitDoesNotJumpScrollAfterReturn();
testSkillsCategorySwipeCommitBypassesPresenceAnimation();

function testSkillsCategoryClickOpenUsesStaticDetail() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const openBlock =
    source.match(
      /const openCategory = useCallback\(\n\s{4}\(categoryId: string\) => \{[\s\S]*?\},\n\s{4}\[[\s\S]*?\]\n\s{2}\);/
    )?.[0] || "";

  assert.match(openBlock, /setSkipNextCategoryTransition\(true\)/);
  assert.match(openBlock, /setCategoryTransitionDirection\(0\)/);
}

testSkillsCategoryClickOpenUsesStaticDetail();

function testSkillsCategoryClickBackUsesStaticReturn() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const closeBlock =
    source.match(/const closeCategory = useCallback\(\(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0] ||
    "";

  assert.match(closeBlock, /setSkipNextCategoryTransition\(true\)/);
  assert.match(closeBlock, /setCategoryTransitionDirection\(0\)/);
  assert.match(source, /const shouldRenderStaticCategoryContent = skipNextCategoryTransition/);
  assert.match(source, /data-ripple-skill-category-static-stage="true"/);
}

testSkillsCategoryClickBackUsesStaticReturn();

function testSkillsCategoryResetToRootUsesStaticReturn() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const resetBlock =
    source.match(
      /useEffect\(\(\) => \{\n\s{4}if \(resetToRootRequest <= 0\)[\s\S]*?\}, \[[\s\S]*?\]\);/
    )?.[0] ||
    "";

  assert.match(resetBlock, /setSkipNextCategoryTransition\(true\)/);
  assert.match(resetBlock, /setCategoryTransitionDirection\(0\)/);
}

testSkillsCategoryResetToRootUsesStaticReturn();
testSkillsCategoryTransitionDoesNotWaitOrKeepExitingPageInLayoutFlow();

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
  assert.match(i18n, /不要直接创建/);
  assert.match(i18n, /最多追问一轮/);
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
  assert.match(source, /disabled=\{!canEdit\}/);
  assert.doesNotMatch(source, /pointer-events-none opacity-60/);
  assert.match(i18n, /workspace-relative directory/);
  assert.match(i18n, /workspace 相对目录/);
  assert.match(i18n, /不要直接修改/);
  assert.match(i18n, /at most one follow-up round/);
  assert.doesNotMatch(i18n, /path: \{path\}/);
  assert.doesNotMatch(i18n, /\/home\/|\.ripple\/sandboxes/);
}

testSkillsPageEditSkillOpensScopedChatPrompt();

function testSkillsPageMobileInteractionFixes() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const motionSource = readFileSync(new URL("./motionPrimitives.ts", import.meta.url), "utf8");
  const androidMainActivity = readFileSync(
    new URL(
      "../../../src-tauri/gen/android/app/src/main/java/com/viaim/ripple/MainActivity.kt",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(motionSource, /edgeStartWidthPx: 72/);
  assert.match(motionSource, /mobileStackCommitTransition/);
  assert.match(androidMainActivity, /96 \* resources\.displayMetrics\.density/);
  assert.match(source, /resetToRootRequest/);
  assert.match(source, /mobileStackCommitTransition/);
  assert.match(source, /isCategorySwipeActive \? "will-change-transform" : "will-change-auto"/);
  assert.match(source, /lg:will-change-auto/);
  assert.match(source, /skillsPageScrollRef\.current\?\.scrollTo\(\{ top: 0/);
  assert.match(appSource, /skillsResetToRootRequest/);
  assert.match(
    appSource,
    /view === activeView && \(view === "skills" \|\| view === "connectors"\)/
  );
  assert.match(source, /confirmDeleteSkillId/);
  assert.match(source, /skills\.confirmDelete/);
  assert.match(source, /renderActiveFilterNotice/);
  assert.match(source, /skills\.activeFilters/);
  assert.match(i18n, /confirmDelete: "确认删除"/);
  assert.match(i18n, /activeFilters: "已应用筛选"/);
  assert.match(i18n, /confirmDelete: "Confirm delete"/);
  assert.match(i18n, /activeFilters: "Filters active"/);
}

testSkillsPageMobileInteractionFixes();

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

function testSkillsPageUsesSolidWorkbenchSurfaces() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_(SECTION|SURFACE|PRIMARY_BUTTON|SECONDARY_BUTTON|STATUS|FIELD|MENU)/);
  assert.match(source, /WORKBENCH_MOBILE_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(source, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(source, /bg-white\/7[02468].*backdrop-blur-xl/);
  assert.doesNotMatch(source, /shadow-\[0_18px_44px/);
  assert.doesNotMatch(source, /backdrop-blur-xl/);
}

testSkillsPageUsesSolidWorkbenchSurfaces();

function testSkillsPageRendersChineseChrome() {
  const html = renderSkillsPage("zh-CN");

  assert.match(html, /sm:hidden[^>]*>能力</);
  assert.match(html, />暂无能力/);
  assert.match(html, /aria-label="刷新"/);
}

testSkillsPageRendersChineseChrome();

console.log("skills page tests passed");
