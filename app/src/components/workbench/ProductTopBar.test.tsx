import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import ProductTopBar from "./ProductTopBar";

const productTopBarSource = readFileSync(new URL("./ProductTopBar.tsx", import.meta.url), "utf8");

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
  assert.match(html, />Tasks</);
  assert.match(html, />Files</);
  assert.match(html, />Skills</);
  assert.match(html, />Connectors</);
  assert.match(html, /data-ripple-top-tab="sessions"/);
  assert.match(html, /data-ripple-top-tab="tasks"/);
  assert.match(html, /data-ripple-top-tab="files"/);
  assert.match(html, /data-ripple-top-tab="skills"/);
  assert.match(html, /data-ripple-top-tab="connectors"/);
  assert.doesNotMatch(html, />Autos</);
  assert.doesNotMatch(html, /data-ripple-top-tab="automations"/);
  assert.doesNotMatch(html, />Links</);
  assert.doesNotMatch(html, /data-ripple-top-tab="home"/);
}

function testSettingsLivesInRightAvatarEntry() {
  const html = renderProductTopBar();

  assert.match(html, /data-ripple-top-settings-entry="true"/);
  assert.match(html, /aria-label="Open personal settings for default"/);
  assert.match(html, /title="Personal settings"/);
  assert.doesNotMatch(html, />Settings<\/span>/);
}

function testSettingsEntryUsesLargerBorderlessAvatarButton() {
  const html = renderProductTopBar();
  const entryButton = html.match(/<button[^>]*data-ripple-top-settings-entry="true"[^>]*>/)?.[0];
  const avatarTile = html.match(
    /<span[^>]*data-ripple-icon-tile="true"[^>]*data-tone="neutral"[^>]*>/
  )?.[0];

  assert.ok(entryButton);
  assert.ok(avatarTile);
  assert.match(entryButton, /h-10/);
  assert.match(entryButton, /w-10/);
  assert.doesNotMatch(entryButton, /h-11/);
  assert.doesNotMatch(entryButton, /w-11/);
  assert.match(entryButton, /rounded-xl/);
  assert.doesNotMatch(entryButton, /rounded-full/);
  assert.doesNotMatch(entryButton, /border-\[#DEE0E3\]/);
  assert.doesNotMatch(entryButton, /bg-white\/82/);
  assert.doesNotMatch(entryButton, /shadow-\[/);
  assert.match(avatarTile, /h-10/);
  assert.match(avatarTile, /w-10/);
}

function testSettingsEntryKeepsLiveStatusDot() {
  const html = renderProductTopBar();

  assert.match(html, /data-ripple-settings-status-dot="true"/);
  assert.doesNotMatch(html, /animate-ping/);
  assert.match(html, /bg-emerald-500/);
}

function testSelectedTopTabUsesFeishuWorkbenchTreatment() {
  const html = renderProductTopBar();

  const selectedTab = html.match(/<button[^>]*data-ripple-top-tab="sessions"[^>]*>/)?.[0] || "";

  assert.match(selectedTab, /border-\[#BACEFD\]/);
  assert.match(selectedTab, /bg-\[#F0F5FF\]/);
  assert.match(selectedTab, /text-\[#1456F0\]/);
  assert.doesNotMatch(selectedTab, /text-white/);
  assert.doesNotMatch(selectedTab, /shadow-\[0_8px_18px_rgba\(20,86,240,0\.22\)\]/);
}

function testProductTopBarUsesSharedWorkbenchTopBarPrimitive() {
  assert.match(productTopBarSource, /WORKBENCH_TOP_BAR_CLASS/);
  assert.doesNotMatch(productTopBarSource, /backdrop-blur-2xl/);
}

function testDesktopProductTabsUseEqualWidths() {
  const html = renderProductTopBar();
  const tabButtons = [...html.matchAll(/<button[^>]*data-ripple-top-tab="[^"]+"[^>]*>/g)].map(
    (match) => match[0]
  );

  assert.equal(tabButtons.length, 5);
  for (const button of tabButtons) {
    assert.match(button, /w-\[132px\]/);
    assert.match(button, /justify-center/);
    assert.match(button, /whitespace-nowrap/);
  }
}

function testDesktopProductTabIconsDoNotShrink() {
  const html = renderProductTopBar();
  const icons = [...html.matchAll(/<svg[^>]*class="[^"]*h-4 w-4 shrink-0[^"]*"[^>]*>/g)];

  assert.equal(icons.length, 5);
}

function testDesktopProductTabsRenderChineseLabels() {
  const html = renderProductTopBar("zh-CN");

  assert.match(html, />会话</);
  assert.match(html, />任务</);
  assert.match(html, />文件</);
  assert.match(html, />能力</);
  assert.match(html, />连接</);
  assert.doesNotMatch(html, />自动化</);
  assert.match(html, /aria-label="打开 default 的个人设置"/);
}

testDesktopProductTabsExcludeSettings();
testSettingsLivesInRightAvatarEntry();
testSettingsEntryUsesLargerBorderlessAvatarButton();
testSettingsEntryKeepsLiveStatusDot();
testSelectedTopTabUsesFeishuWorkbenchTreatment();
testProductTopBarUsesSharedWorkbenchTopBarPrimitive();
testDesktopProductTabsUseEqualWidths();
testDesktopProductTabIconsDoNotShrink();
testDesktopProductTabsRenderChineseLabels();

console.log("product top bar tests passed");
