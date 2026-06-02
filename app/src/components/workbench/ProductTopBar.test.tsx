import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import ProductTopBar from "./ProductTopBar";

function noop() {}

function renderProductTopBar(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <ProductTopBar
        activeView="sessions"
        userId="default"
        onSelectView={noop}
        onOpenSettings={noop}
      />
    </I18nProvider>
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

  assert.match(selectedTab, /bg-\[#007aff\]/);
  assert.match(selectedTab, /text-white/);
  assert.match(selectedTab, /shadow-\[0_8px_18px_rgba\(0,122,255,0\.22\)\]/);
}

function testDesktopProductTabsUseEqualWidths() {
  const html = renderProductTopBar();
  const tabButtons = [...html.matchAll(/<button[^>]*data-ripple-top-tab="[^"]+"[^>]*>/g)].map(
    (match) => match[0]
  );

  assert.equal(tabButtons.length, 4);
  for (const button of tabButtons) {
    assert.match(button, /w-\[132px\]/);
    assert.match(button, /justify-center/);
    assert.match(button, /whitespace-nowrap/);
  }
}

function testDesktopProductTabIconsDoNotShrink() {
  const html = renderProductTopBar();
  const icons = [...html.matchAll(/<svg[^>]*class="[^"]*h-4 w-4 shrink-0[^"]*"[^>]*>/g)];

  assert.equal(icons.length, 4);
}

function testDesktopProductTabsRenderChineseLabels() {
  const html = renderProductTopBar("zh-CN");

  assert.match(html, />会话</);
  assert.match(html, />文件</);
  assert.match(html, />自动化</);
  assert.match(html, />连接器</);
  assert.match(html, /aria-label="打开 default 的个人设置"/);
}

testDesktopProductTabsExcludeSettings();
testSettingsLivesInRightAvatarEntry();
testSettingsEntryKeepsLiveStatusDot();
testSelectedTopTabHasStrongerTreatment();
testDesktopProductTabsUseEqualWidths();
testDesktopProductTabIconsDoNotShrink();
testDesktopProductTabsRenderChineseLabels();

console.log("product top bar tests passed");
