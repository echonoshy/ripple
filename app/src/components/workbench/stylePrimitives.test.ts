import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMPACT_IOS_PAGE_BACKGROUND,
  MOBILE_LABEL_TEXT_CLASS,
  MOBILE_DETAIL_HEADER_TITLE_CLASS,
  MOBILE_DETAIL_PAGE_HEADER_CLASS,
  MOBILE_MAIN_TEXT_CLASS,
  MOBILE_META_TEXT_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  MOBILE_READABLE_TEXT_CLASS,
  MOBILE_STATUS_TEXT_CLASS,
  MOBILE_TAB_BAR_MASK_HEIGHT_CLASS,
  LUCIDE_STANDARD_STROKE_WIDTH,
  LUCIDE_NAV_STROKE_WIDTH,
  WORKBENCH_DANGER_BUTTON_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_FLOATING_SURFACE_CLASS,
  WORKBENCH_GHOST_BUTTON_CLASS,
  WORKBENCH_ICON_BUTTON_CLASS,
  WORKBENCH_MENU_CLASS,
  WORKBENCH_MENU_DANGER_ITEM_CLASS,
  WORKBENCH_MENU_ITEM_CLASS,
  WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS,
  WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
  WORKBENCH_SECTION_CLASS,
  WORKBENCH_STATUS_DANGER_CLASS,
  WORKBENCH_STATUS_NEUTRAL_CLASS,
  WORKBENCH_STATUS_SUCCESS_CLASS,
  WORKBENCH_STATUS_WARNING_CLASS,
  WORKBENCH_SURFACE_CLASS,
  WORKBENCH_TOP_BAR_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  TYPOGRAPHY_SECTION_TITLE_CLASS,
} from "./stylePrimitives";

assert.equal(WORKBENCH_PAGE_BACKGROUND_CLASS, "bg-[#F5F6F7]");
assert.equal(COMPACT_IOS_PAGE_BACKGROUND, WORKBENCH_PAGE_BACKGROUND_CLASS);
assert.match(WORKBENCH_SURFACE_CLASS, /bg-white/);
assert.match(WORKBENCH_SURFACE_CLASS, /border-\[#DEE0E3\]/);
assert.doesNotMatch(WORKBENCH_SURFACE_CLASS, /backdrop-blur/);
assert.doesNotMatch(WORKBENCH_SURFACE_CLASS, /bg-white\/8/);
assert.match(WORKBENCH_SECTION_CLASS, /rounded-xl/);
assert.match(WORKBENCH_SECTION_CLASS, /border-\[#DEE0E3\]/);
assert.doesNotMatch(WORKBENCH_SECTION_CLASS, /backdrop-blur/);
assert.match(WORKBENCH_FLOATING_SURFACE_CLASS, /shadow-\[0_12px_32px_rgba\(31,35,41,0\.14\)\]/);
assert.match(WORKBENCH_TOP_BAR_CLASS, /border-b/);
assert.match(WORKBENCH_TOP_BAR_CLASS, /bg-white/);
assert.doesNotMatch(WORKBENCH_TOP_BAR_CLASS, /backdrop-blur/);
assert.match(WORKBENCH_ICON_BUTTON_CLASS, /h-8 w-8/);
assert.match(WORKBENCH_ICON_BUTTON_CLASS, /rounded-lg/);
assert.doesNotMatch(WORKBENCH_ICON_BUTTON_CLASS, /backdrop-blur/);
assert.match(WORKBENCH_MOBILE_ICON_BUTTON_CLASS, /h-11 w-11/);
assert.match(WORKBENCH_MOBILE_ICON_BUTTON_CLASS, /rounded-xl/);
assert.doesNotMatch(WORKBENCH_MOBILE_ICON_BUTTON_CLASS, /rounded-full/);
assert.match(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS, /h-11 w-11/);
assert.match(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS, /rounded-xl/);
assert.match(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS, /bg-transparent/);
assert.doesNotMatch(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS, /border-\[#DEE0E3\]/);
assert.doesNotMatch(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS, /\bborder\b/);
assert.match(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS, /bg-\[#F0F5FF\]/);
assert.match(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS, /text-\[#1456F0\]/);
assert.doesNotMatch(WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS, /\bborder\b/);
assert.match(WORKBENCH_PRIMARY_BUTTON_CLASS, /bg-\[#1456F0\]/);
assert.match(WORKBENCH_SECONDARY_BUTTON_CLASS, /border-\[#DEE0E3\]/);
assert.match(WORKBENCH_GHOST_BUTTON_CLASS, /bg-transparent/);
assert.match(WORKBENCH_DANGER_BUTTON_CLASS, /text-\[#B42318\]/);
assert.match(WORKBENCH_FIELD_CLASS, /focus:border-\[#1456F0\]/);
assert.match(WORKBENCH_MENU_CLASS, /rounded-xl/);
assert.match(WORKBENCH_MENU_ITEM_CLASS, /h-8/);
assert.match(WORKBENCH_MENU_DANGER_ITEM_CLASS, /text-\[#B42318\]/);
assert.match(WORKBENCH_STATUS_SUCCESS_CLASS, /text-\[#16845B\]/);
assert.match(WORKBENCH_STATUS_WARNING_CLASS, /text-\[#8B5E00\]/);
assert.match(WORKBENCH_STATUS_DANGER_CLASS, /text-\[#B42318\]/);
assert.match(WORKBENCH_STATUS_NEUTRAL_CLASS, /text-\[#646A73\]/);
assert.equal(TYPOGRAPHY_PAGE_TITLE_CLASS, "text-[20px] leading-[30px] font-medium tracking-normal");
assert.equal(
  MOBILE_DETAIL_HEADER_TITLE_CLASS,
  "text-[18px] leading-[26px] font-medium tracking-normal"
);
assert.equal(MOBILE_DETAIL_PAGE_HEADER_CLASS, "-mx-3 -mt-[max(env(safe-area-inset-top),12px)]");
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
assert.equal(MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS, "pb-[calc(84px+env(safe-area-inset-bottom))]");
assert.equal(MOBILE_TAB_BAR_MASK_HEIGHT_CLASS, "h-[calc(84px+env(safe-area-inset-bottom))]");
assert.equal(LUCIDE_STANDARD_STROKE_WIDTH, 2.2);
assert.equal(LUCIDE_NAV_STROKE_WIDTH, 2.25);

const stylePrimitivesSource = readFileSync(
  new URL("./stylePrimitives.ts", import.meta.url),
  "utf8"
);
assert.match(stylePrimitivesSource, /WORKBENCH_BRAND_BLUE = "#1456F0"/);
assert.match(stylePrimitivesSource, /WORKBENCH_TEXT_PRIMARY = "#1F2329"/);
assert.match(stylePrimitivesSource, /WORKBENCH_TEXT_SECONDARY = "#646A73"/);
assert.match(stylePrimitivesSource, /WORKBENCH_TEXT_TERTIARY = "#8F959E"/);
assert.match(stylePrimitivesSource, /WORKBENCH_BORDER_2 = "#DEE0E3"/);
assert.match(stylePrimitivesSource, /WORKBENCH_PAGE_CONTENT_CLASS = "mx-auto w-full max-w-7xl"/);

const sharedWidthPageSources = ["./FilesPage.tsx", "./SkillsPage.tsx"];

for (const sourcePath of sharedWidthPageSources) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  assert.match(source, /WORKBENCH_PAGE_CONTENT_CLASS/, `${sourcePath} uses shared page width`);
  assert.doesNotMatch(
    source,
    /mx-auto (?:w-full )?max-w-5xl/,
    `${sourcePath} avoids narrow 5xl page width`
  );
}

const workspaceExplorerSource = readFileSync(
  new URL("../WorkspaceExplorer.tsx", import.meta.url),
  "utf8"
);
assert.match(
  workspaceExplorerSource,
  /lg:grid-cols-\[244px_var\(--ripple-workspace-list-column\)\]/
);
assert.match(workspaceExplorerSource, /"--ripple-workspace-list-column"/);
assert.match(workspaceExplorerSource, /minmax\(280px, \$\{splitPercent\}%\) minmax\(280px, 1fr\)/);
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
assert.match(globalsCss, /--ripple-brand: #1456f0/);
assert.match(globalsCss, /--ripple-text-primary: #1f2329/);
assert.match(globalsCss, /--ripple-border-2: #dee0e3/);
assert.doesNotMatch(globalsCss, /#007aff/i);

console.log("style primitives tests passed");
