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

console.log("mobile tab bar tests passed");
