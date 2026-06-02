import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import MobileTabBar from "./MobileTabBar";

const mobileTabBarSource = readFileSync(new URL("./MobileTabBar.tsx", import.meta.url), "utf8");

function noop() {}

function renderMobileTabBar(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <MobileTabBar activeView="connectors" onSelectView={noop} />
    </I18nProvider>
  );
}

function testUsesShortMobileNavigationLabels() {
  const html = renderMobileTabBar();

  assert.match(html, />Sessions</);
  assert.match(html, /aria-label="Open Sessions"/);
  assert.match(html, />Files</);
  assert.match(html, /aria-label="Open Files"/);
  assert.match(html, />Connectors</);
  assert.match(html, /aria-label="Open Connectors"/);
  assert.match(html, />Automations</);
  assert.match(html, /aria-label="Open Automations"/);
  assert.match(html, />Settings</);
  assert.match(html, /aria-label="Open Settings"/);
  assert.doesNotMatch(html, />New</);
  assert.doesNotMatch(html, />Tasks</);
}

testUsesShortMobileNavigationLabels();

function testUsesChineseMobileNavigationLabels() {
  const html = renderMobileTabBar("zh-CN");

  assert.match(html, />会话</);
  assert.match(html, /aria-label="打开会话"/);
  assert.match(html, />文件</);
  assert.match(html, />连接器</);
  assert.match(html, />自动化</);
  assert.match(html, />设置</);
}

testUsesChineseMobileNavigationLabels();

function testReservesIosSafeAreaAndStableTouchHeight() {
  const html = renderMobileTabBar();

  assert.match(html, /bottom-\[max\(env\(safe-area-inset-bottom\),10px\)\]/);
  assert.match(html, /h-\[58px\]/);
}

testReservesIosSafeAreaAndStableTouchHeight();

function testUsesQuietSelectedTabTreatment() {
  const html = renderMobileTabBar();

  assert.match(html, /bg-white\/74/);
  assert.match(html, /backdrop-blur-2xl/);
  assert.match(html, /shadow-\[0_18px_44px_rgba\(60,60,67,0\.20\)\]/);
  assert.match(html, /data-ripple-icon-tile="true"/);
  assert.match(html, /bg-\[#eaf4ff\]/);
  assert.match(html, /text-\[#007aff\]/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /shadow-\[0_-14px_34px/);
}

testUsesQuietSelectedTabTreatment();

function testEveryMobileTabUsesSoftIconTile() {
  const html = renderMobileTabBar();

  assert.equal((html.match(/data-ripple-icon-tile="true"/g) || []).length, 5);
  assert.match(html, /data-tone="accent"/);
  assert.match(html, /data-tone="neutral"/);
}

testEveryMobileTabUsesSoftIconTile();

function testUsesSharedNavigationIconStrokeWeight() {
  assert.match(mobileTabBarSource, /LUCIDE_NAV_STROKE_WIDTH/);
  assert.match(mobileTabBarSource, /mobileNavItems/);
  assert.doesNotMatch(mobileTabBarSource, /2\.45/);
}

testUsesSharedNavigationIconStrokeWeight();

console.log("mobile tab bar tests passed");
