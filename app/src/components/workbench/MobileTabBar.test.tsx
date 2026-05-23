import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MobileTabBar from "./MobileTabBar";

function noop() {}

function renderMobileTabBar() {
  return renderToStaticMarkup(
    <MobileTabBar activeView="connectors" onSelectView={noop} onOpenSettings={noop} />
  );
}

function testUsesShortMobileNavigationLabels() {
  const html = renderMobileTabBar();

  assert.match(html, />Sessions</);
  assert.match(html, /aria-label="Open Sessions"/);
  assert.match(html, />Auto</);
  assert.match(html, /aria-label="Open Auto"/);
  assert.match(html, />Apps</);
  assert.match(html, /aria-label="Open Apps"/);
  assert.match(html, /aria-label="Open Settings"/);
  assert.doesNotMatch(html, />Connectors</);
  assert.doesNotMatch(html, />Tasks</);
}

testUsesShortMobileNavigationLabels();

function testReservesIosSafeAreaAndStableTouchHeight() {
  const html = renderMobileTabBar();

  assert.match(html, /min-h-\[calc\(64px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(html, /pb-\[max\(env\(safe-area-inset-bottom\),12px\)\]/);
}

testReservesIosSafeAreaAndStableTouchHeight();

console.log("mobile tab bar tests passed");
