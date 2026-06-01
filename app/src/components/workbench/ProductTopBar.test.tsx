import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ProductTopBar from "./ProductTopBar";

function noop() {}

function renderProductTopBar() {
  return renderToStaticMarkup(
    <ProductTopBar
      activeView="sessions"
      userId="default"
      onSelectView={noop}
      onOpenSettings={noop}
    />
  );
}

function testDesktopProductTabsExcludeSettings() {
  const html = renderProductTopBar();

  assert.match(html, /data-ripple-product-top-bar="true"/);
  assert.match(html, />Sessions</);
  assert.match(html, />Files</);
  assert.match(html, />Automations</);
  assert.match(html, />Connectors</);
  assert.match(html, /data-ripple-top-tab="sessions"/);
  assert.match(html, /data-ripple-top-tab="files"/);
  assert.match(html, /data-ripple-top-tab="automations"/);
  assert.match(html, /data-ripple-top-tab="connectors"/);
  assert.doesNotMatch(html, /data-ripple-top-tab="home"/);
}

function testSettingsLivesInRightAvatarEntry() {
  const html = renderProductTopBar();

  assert.match(html, /data-ripple-top-settings-entry="true"/);
  assert.match(html, /aria-label="Open personal settings for default"/);
  assert.match(html, /title="Personal settings"/);
  assert.doesNotMatch(html, />Settings<\/span>/);
}

function testSettingsEntryKeepsLiveStatusDot() {
  const html = renderProductTopBar();

  assert.match(html, /data-ripple-settings-status-dot="true"/);
  assert.match(html, /animate-ping/);
  assert.match(html, /bg-emerald-500/);
}

function testSelectedTopTabHasStrongerTreatment() {
  const html = renderProductTopBar();

  const selectedTab = html.match(/<button[^>]*data-ripple-top-tab="sessions"[^>]*>/)?.[0] || "";

  assert.match(selectedTab, /bg-\[#eef4ff\]/);
  assert.match(selectedTab, /ring-1/);
  assert.match(selectedTab, /shadow-\[0_10px_24px_rgba\(47,107,255,0\.18\)\]/);
}

testDesktopProductTabsExcludeSettings();
testSettingsLivesInRightAvatarEntry();
testSettingsEntryKeepsLiveStatusDot();
testSelectedTopTabHasStrongerTreatment();

console.log("product top bar tests passed");
