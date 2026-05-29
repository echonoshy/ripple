import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SystemPage from "./SystemPage";

function noop() {}

function testSystemPageRendersOperationalSurface() {
  const html = renderToStaticMarkup(<SystemPage userId="default" onAuthExpired={noop} />);

  assert.match(html, />System</);
  assert.match(html, />Ready</);
  assert.match(html, />Doctor checks</);
  assert.match(html, />Runtime boundary</);
  assert.match(html, />Backup contract</);
}

testSystemPageRendersOperationalSurface();

console.log("system page tests passed");
