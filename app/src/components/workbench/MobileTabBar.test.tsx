import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MobileTabBar from "./MobileTabBar";

function noop() {}

function renderMobileTabBar() {
  return renderToStaticMarkup(<MobileTabBar activeView="connectors" onSelectView={noop} />);
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

function testReservesIosSafeAreaAndStableTouchHeight() {
  const html = renderMobileTabBar();

  assert.match(html, /min-h-\[calc\(64px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(html, /pb-\[max\(env\(safe-area-inset-bottom\),10px\)\]/);
}

testReservesIosSafeAreaAndStableTouchHeight();

function testUsesQuietSelectedTabTreatment() {
  const html = renderMobileTabBar();

  assert.match(html, /bg-white\/72/);
  assert.match(html, /backdrop-blur-2xl/);
  assert.match(html, /shadow-\[0_-12px_30px_rgba\(44,63,123,0\.10\)\]/);
  assert.match(html, /bg-\[#eef4ff\]\/80/);
  assert.match(html, /text-\[#2463eb\]/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /shadow-\[0_-14px_34px/);
}

testUsesQuietSelectedTabTreatment();

console.log("mobile tab bar tests passed");
