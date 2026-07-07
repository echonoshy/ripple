import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/i18n";
import BrowserPanel from "./BrowserPanel";

function noop() {}

function testBrowserPanelRendersBrowserControls() {
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <BrowserPanel onBrowserContextChange={noop} />
    </I18nProvider>
  );

  assert.match(html, /data-ripple-browser-panel="true"/);
  assert.match(html, /aria-label="Browser address"/);
  assert.match(html, /aria-label="Open page"/);
  assert.match(html, /aria-label="Refresh page"/);
  assert.match(html, /aria-label="Open externally"/);
  assert.match(html, /data-ripple-browser-frame="true"/);
}

function testBrowserPanelBuildsAgentReadableContext() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchBrowserPage/);
  assert.match(source, /buildBrowserContext/);
  assert.match(source, /onBrowserContextChange\(context\.active \? context : null\)/);
}

testBrowserPanelRendersBrowserControls();
testBrowserPanelBuildsAgentReadableContext();

console.log("browser panel tests passed");
