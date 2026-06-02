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
assert.match(MOBILE_READABLE_TEXT_CLASS, /text-\[15px\]/);
assert.match(MOBILE_READABLE_TEXT_CLASS, /leading-6/);
assert.match(MOBILE_MAIN_TEXT_CLASS, /text-\[15px\]/);
assert.match(MOBILE_LABEL_TEXT_CLASS, /text-\[13px\]/);
assert.match(MOBILE_META_TEXT_CLASS, /text-\[12px\]/);
assert.match(MOBILE_STATUS_TEXT_CLASS, /text-\[11px\]/);
assert.equal(MOBILE_PAGE_TOP_SAFE_AREA_CLASS, "pt-[max(env(safe-area-inset-top),12px)]");
assert.equal(MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS, "pb-[calc(96px+env(safe-area-inset-bottom))]");
assert.equal(MOBILE_TAB_BAR_MASK_HEIGHT_CLASS, "h-[calc(96px+env(safe-area-inset-bottom))]");
assert.equal(LUCIDE_STANDARD_STROKE_WIDTH, 2.2);
assert.equal(LUCIDE_NAV_STROKE_WIDTH, 2.25);

const mobileReadableSources = [
  "./MobileTabBar.tsx",
  "./MobileSessionsPage.tsx",
  "./SessionComposer.tsx",
  "./SessionTimeline.tsx",
  "./SessionPage.tsx",
  "./SwipeActionRow.tsx",
  "./WorkspaceFolderPicker.tsx",
  "./WorkspaceNav.tsx",
  "./ConnectorsPage.tsx",
  "./AutomationsPage.tsx",
  "./SettingsPage.tsx",
  "../WorkspaceExplorer.tsx",
];

for (const sourcePath of mobileReadableSources) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  assert.doesNotMatch(source, /text-\[(?:9|10)px\]/, `${sourcePath} uses sub-11px text`);
}

console.log("style primitives tests passed");
