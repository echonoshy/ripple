import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMPACT_IOS_PAGE_BACKGROUND,
  GLASS_PANEL_CLASS,
  GLASS_TOP_BAR_CLASS,
  DENSE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_LABEL_TEXT_CLASS,
  MOBILE_MAIN_TEXT_CLASS,
  MOBILE_META_TEXT_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  MOBILE_READABLE_TEXT_CLASS,
  MOBILE_STATUS_TEXT_CLASS,
  MOBILE_TAB_BAR_MASK_HEIGHT_CLASS,
  LUCIDE_STANDARD_STROKE_WIDTH,
  LUCIDE_NAV_STROKE_WIDTH,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  TYPOGRAPHY_SECTION_TITLE_CLASS,
} from "./stylePrimitives";

assert.match(COMPACT_IOS_PAGE_BACKGROUND, /#f2f2f7/);
assert.doesNotMatch(COMPACT_IOS_PAGE_BACKGROUND, /radial-gradient/);
assert.doesNotMatch(COMPACT_IOS_PAGE_BACKGROUND, /139,92,246/);
assert.doesNotMatch(COMPACT_IOS_PAGE_BACKGROUND, /20,184,166/);
assert.match(GLASS_PANEL_CLASS, /bg-white\/82/);
assert.match(GLASS_PANEL_CLASS, /border-\[#d7d7dd\]/);
assert.match(GLASS_PANEL_CLASS, /backdrop-blur-xl/);
assert.match(GLASS_TOP_BAR_CLASS, /bg-white\/76/);
assert.match(GLASS_TOP_BAR_CLASS, /backdrop-blur-2xl/);
assert.match(DENSE_GLASS_ICON_BUTTON_CLASS, /h-8 w-8/);
assert.match(MOBILE_GLASS_ICON_BUTTON_CLASS, /h-11 w-11/);
assert.match(MOBILE_GLASS_ICON_BUTTON_CLASS, /rounded-full/);
assert.equal(TYPOGRAPHY_PAGE_TITLE_CLASS, "text-[20px] leading-[30px] font-medium tracking-normal");
assert.equal(TYPOGRAPHY_SECTION_TITLE_CLASS, "text-[16px] leading-6 font-medium tracking-normal");
assert.equal(TYPOGRAPHY_BODY_CLASS, "text-[14px] leading-[22px]");
assert.equal(TYPOGRAPHY_BODY_MEDIUM_CLASS, "text-[14px] leading-[22px] font-medium");
assert.equal(TYPOGRAPHY_MOBILE_BODY_CLASS, "text-[16px] leading-6");
assert.equal(TYPOGRAPHY_META_CLASS, "text-[12px] leading-5");
assert.equal(TYPOGRAPHY_MICRO_CLASS, "text-[11px] leading-4");
assert.equal(MOBILE_READABLE_TEXT_CLASS, TYPOGRAPHY_MOBILE_BODY_CLASS);
assert.equal(MOBILE_MAIN_TEXT_CLASS, TYPOGRAPHY_MOBILE_BODY_CLASS);
assert.equal(MOBILE_LABEL_TEXT_CLASS, TYPOGRAPHY_BODY_CLASS);
assert.equal(MOBILE_META_TEXT_CLASS, TYPOGRAPHY_META_CLASS);
assert.equal(MOBILE_STATUS_TEXT_CLASS, TYPOGRAPHY_MICRO_CLASS);
assert.equal(MOBILE_PAGE_TOP_SAFE_AREA_CLASS, "pt-[max(env(safe-area-inset-top),12px)]");
assert.equal(MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS, "pb-[calc(96px+env(safe-area-inset-bottom))]");
assert.equal(MOBILE_TAB_BAR_MASK_HEIGHT_CLASS, "h-[calc(96px+env(safe-area-inset-bottom))]");
assert.equal(LUCIDE_STANDARD_STROKE_WIDTH, 2.2);
assert.equal(LUCIDE_NAV_STROKE_WIDTH, 2.25);

const stylePrimitivesSource = readFileSync(new URL("./stylePrimitives.ts", import.meta.url), "utf8");
assert.match(
  stylePrimitivesSource,
  /WORKBENCH_PAGE_CONTENT_CLASS = "mx-auto w-full max-w-7xl"/
);

const sharedWidthPageSources = [
  "./FilesPage.tsx",
  "./SkillsPage.tsx",
  "./ConnectorsPage.tsx",
  "./AutomationsPage.tsx",
];

for (const sourcePath of sharedWidthPageSources) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  assert.match(source, /WORKBENCH_PAGE_CONTENT_CLASS/, `${sourcePath} uses shared page width`);
  assert.doesNotMatch(source, /mx-auto (?:w-full )?max-w-5xl/, `${sourcePath} avoids narrow 5xl page width`);
}

const workspaceExplorerSource = readFileSync(
  new URL("../WorkspaceExplorer.tsx", import.meta.url),
  "utf8"
);
assert.match(
  workspaceExplorerSource,
  /lg:grid-cols-\[minmax\(280px,360px\)_minmax\(0,1fr\)\]/
);
assert.doesNotMatch(workspaceExplorerSource, /minmax\(320px,440px\)_minmax\(0,1fr\)/);

const mobileReadableSources = [
  "./MobileTabBar.tsx",
  "./MobileSessionsPage.tsx",
  "./SessionComposer.tsx",
  "./SessionTimeline.tsx",
  "./SessionPage.tsx",
  "./SwipeActionRow.tsx",
  "./WorkspaceFolderPicker.tsx",
  "./WorkspaceNav.tsx",
  "./SkillsPage.tsx",
  "./ConnectorsPage.tsx",
  "./AutomationsPage.tsx",
  "./SettingsPage.tsx",
  "../WorkspaceExplorer.tsx",
];

for (const sourcePath of mobileReadableSources) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  assert.doesNotMatch(source, /text-\[(?:9|10)px\]/, `${sourcePath} uses sub-11px text`);
}

const globalsCss = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");
assert.match(globalsCss, /-apple-system/);
assert.match(globalsCss, /BlinkMacSystemFont/);
assert.match(globalsCss, /"PingFang SC"/);
assert.match(globalsCss, /"Microsoft YaHei UI"/);
assert.match(globalsCss, /"Noto Sans SC"/);
assert.match(globalsCss, /"Segoe UI"/);
assert.match(globalsCss, /"Helvetica Neue"/);

console.log("style primitives tests passed");
