import assert from "node:assert/strict";

import {
  COMPACT_IOS_PAGE_BACKGROUND,
  GLASS_PANEL_CLASS,
  GLASS_TOP_BAR_CLASS,
  DENSE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  LUCIDE_STANDARD_STROKE_WIDTH,
  LUCIDE_NAV_STROKE_WIDTH,
} from "./stylePrimitives";

assert.match(COMPACT_IOS_PAGE_BACKGROUND, /rgba\(47,107,255,0\.11\)/);
assert.match(COMPACT_IOS_PAGE_BACKGROUND, /rgba\(139,92,246,0\.09\)/);
assert.doesNotMatch(COMPACT_IOS_PAGE_BACKGROUND, /20,184,166/);
assert.match(GLASS_PANEL_CLASS, /bg-white\/78/);
assert.match(GLASS_PANEL_CLASS, /border-\[#dfe6f4\]/);
assert.match(GLASS_PANEL_CLASS, /backdrop-blur-xl/);
assert.match(GLASS_TOP_BAR_CLASS, /bg-white\/72/);
assert.match(GLASS_TOP_BAR_CLASS, /backdrop-blur-2xl/);
assert.match(DENSE_GLASS_ICON_BUTTON_CLASS, /h-8 w-8/);
assert.match(MOBILE_GLASS_ICON_BUTTON_CLASS, /h-9 w-9/);
assert.equal(LUCIDE_STANDARD_STROKE_WIDTH, 2.2);
assert.equal(LUCIDE_NAV_STROKE_WIDTH, 2.25);

console.log("style primitives tests passed");
