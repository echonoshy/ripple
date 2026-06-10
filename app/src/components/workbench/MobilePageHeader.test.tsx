import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search } from "lucide-react";

import MobilePageHeader from "./MobilePageHeader";

const source = readFileSync(new URL("./MobilePageHeader.tsx", import.meta.url), "utf8");

function noop() {}

function testMobilePageHeaderHasSharedStructure() {
  const html = renderToStaticMarkup(
    <MobilePageHeader
      title="Files"
      subtitle="3 items"
      backLabel="Back to session"
      onBack={noop}
      actions={
        <button type="button" aria-label="Search">
          <Search size={18} />
        </button>
      }
    />
  );

  assert.match(html, /data-ripple-mobile-page-header="true"/);
  assert.match(html, /data-ripple-mobile-page-header-title="true"[^>]*>Files</);
  assert.match(html, />3 items</);
  assert.match(html, /aria-label="Back to session"/);
  assert.match(html, /aria-label="Search"/);
  assert.match(html, /grid-cols-\[44px_minmax\(0,1fr\)_auto\]/);
  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),12px\)\]/);
  assert.match(html, /border-b border-\[#DEE0E3\]/);
  assert.match(source, /WORKBENCH_MOBILE_ICON_BUTTON_CLASS/);
}

function testMobilePageHeaderSupportsGhostBackButton() {
  const html = renderToStaticMarkup(
    <MobilePageHeader
      title="Automations"
      backLabel="Back"
      onBack={noop}
      backButtonVariant="ghost"
    />
  );
  const backButton = html.match(/<button[^>]*aria-label="Back"[^>]*>/)?.[0] || "";

  assert.match(source, /WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS/);
  assert.match(backButton, /bg-transparent/);
  assert.doesNotMatch(backButton, /border-\[#DEE0E3\]/);
  assert.doesNotMatch(backButton, /bg-white/);
}

function testMobilePageHeaderSupportsCompactTitleClass() {
  const html = renderToStaticMarkup(
    <MobilePageHeader
      title="Long automation title"
      subtitle="Jun 10, 11:45 PM"
      backLabel="Back"
      onBack={noop}
      titleClassName="text-[18px] leading-[26px] font-medium"
    />
  );

  assert.match(
    html,
    /data-ripple-mobile-page-header-title="true" class="[^"]*text-\[18px\][^"]*leading-\[26px\][^"]*font-medium[^"]*"/
  );
  assert.doesNotMatch(
    html,
    /data-ripple-mobile-page-header-title="true" class="[^"]*text-\[20px\]/
  );
}

testMobilePageHeaderHasSharedStructure();
testMobilePageHeaderSupportsGhostBackButton();
testMobilePageHeaderSupportsCompactTitleClass();

console.log("mobile page header tests passed");
