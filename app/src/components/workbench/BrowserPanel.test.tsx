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

function testBrowserPanelKeepsNativeBrowserOutOfAgentContext() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /publishNativeBrowserState/);
  assert.match(source, /onBrowserContextChange\(null\)/);
  assert.doesNotMatch(source, /publishContext\(nativeUrl,\s*null\)/);
  assert.doesNotMatch(source, /publishContext\(event\.url,\s*null\)/);
}

function testBrowserPanelExplainsBlockedEmbeddedPreview() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /page\?\.embeddable === false/);
  assert.match(source, /browser\.previewBlocked/);
}

function testBrowserPanelUsesSandboxedPreviewHtml() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /shouldUsePreviewHtml = Boolean\(page\?\.preview_html\)/);
  assert.match(source, /srcDoc=\{shouldUsePreviewHtml \? \(page\?\.preview_html/);
  assert.match(source, /ripple-browser-navigate/);
  assert.match(source, /window\.addEventListener\("message"/);
  assert.doesNotMatch(source, /allow-popups/);
  assert.doesNotMatch(source, /allow-popups-to-escape-sandbox/);
}

function testBrowserPanelUsesNativeTauriBrowserWhenAvailable() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /createNativeBrowserSurface/);
  assert.match(source, /isNativeBrowserAvailable/);
  assert.match(source, /nativeBrowserViewportRef/);
  assert.match(source, /nativeBrowserRef/);
  assert.match(source, /data-ripple-native-browser-viewport/);
  assert.match(source, /browser\.nativeMode/);
}

function testBrowserPanelUsesNativeHistoryControlsOnDesktop() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /nativeBrowserRef\.current\.goBack/);
  assert.match(source, /nativeBrowserRef\.current\.goForward/);
  assert.match(source, /nativeCanGoBack/);
  assert.match(source, /nativeCanGoForward/);
}

function testBrowserPanelDirectlyFramesHttpWebSites() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /isDirectBrowserIframeUrl/);
  assert.match(source, /shouldUseDirectIframe/);
  assert.match(source, /isDirectBrowserIframeUrl\(normalizedAddress\)/);
  assert.match(source, /sandbox=\{[\s\S]*shouldUseDirectIframe\s*\?\s*undefined/);
}

function testBrowserPanelAvoidsStalePreviewAndSlowFetchJank() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /latestCaptureIdRef/);
  assert.match(source, /captureId !== latestCaptureIdRef\.current/);
  assert.match(source, /onLoad=\{handleFrameLoad\}/);
  assert.match(source, /setPendingNavigationUrl\(normalizedAddress \|\| null\)/);
  assert.match(source, /setFrameUrl\(resolvedUrl\)/);
  assert.match(source, /setFrameVersion\(\(current\) => current \+ 1\)/);
  assert.doesNotMatch(source, /setFrameUrl\(normalizedAddress\)/);
}

function testBrowserPanelShowsCodexStyleLoadingAndEmptyState() {
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <BrowserPanel onBrowserContextChange={noop} />
    </I18nProvider>
  );
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-browser-loading-bar/);
  assert.match(source, /browser\.emptyTitle/);
  assert.match(html, /Start browsing/);
}

testBrowserPanelRendersBrowserControls();
testBrowserPanelBuildsAgentReadableContext();
testBrowserPanelKeepsNativeBrowserOutOfAgentContext();
testBrowserPanelExplainsBlockedEmbeddedPreview();
testBrowserPanelUsesSandboxedPreviewHtml();
testBrowserPanelUsesNativeTauriBrowserWhenAvailable();
testBrowserPanelUsesNativeHistoryControlsOnDesktop();
testBrowserPanelDirectlyFramesHttpWebSites();
testBrowserPanelAvoidsStalePreviewAndSlowFetchJank();
testBrowserPanelShowsCodexStyleLoadingAndEmptyState();

console.log("browser panel tests passed");
