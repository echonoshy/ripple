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
  assert.match(source, /captureCurrentPage/);
  assert.match(source, /nativeBrowserViewportRef/);
  assert.match(source, /nativeBrowserRef/);
  assert.match(source, /data-ripple-native-browser-viewport/);
  assert.match(source, /browser\.nativeMode/);
}

function testBrowserPanelKeepsNavigationInsideApp() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /systemBrowserMode/);
  assert.doesNotMatch(source, /openInSystemBrowser/);
  assert.doesNotMatch(source, /openExternalUrl\(normalizedAddress,\s*"ripple-browser"\)/);
  assert.match(source, /void capturePage\(address\)/);
  assert.match(source, /void capturePage\(event\.data\.url\)/);
}

function testBrowserPanelDirectlyFramesHttpWebSites() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /isDirectBrowserIframeUrl/);
  assert.match(source, /shouldUseDirectIframe/);
  assert.match(source, /isDirectBrowserIframeUrl\(normalizedAddress\)/);
  assert.match(source, /sandbox=\{[\s\S]*shouldUseDirectIframe\s*\?\s*undefined/);
}

function testBrowserPanelPreservesAgentReadableContextInNativeMode() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /publishContext\(event\.url,\s*null\)/);
  assert.doesNotMatch(
    source,
    /setPendingNavigationUrl\(null\);\s*return;\s*}\s*catch \(nativeError\)/
  );
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

function testBrowserPanelRequiresExplicitPageAttachment() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /browser\.attachCurrentPage/);
  assert.match(source, /browser\.attachedCurrentPage/);
  assert.match(source, /handleAttachCurrentPage/);
  assert.doesNotMatch(source, /handleNativePageLoad[\s\S]*publishContext\(event\.url,\s*null\)/);
}

testBrowserPanelRendersBrowserControls();
testBrowserPanelBuildsAgentReadableContext();
testBrowserPanelExplainsBlockedEmbeddedPreview();
testBrowserPanelUsesSandboxedPreviewHtml();
testBrowserPanelUsesNativeTauriBrowserWhenAvailable();
testBrowserPanelKeepsNavigationInsideApp();
testBrowserPanelDirectlyFramesHttpWebSites();
testBrowserPanelPreservesAgentReadableContextInNativeMode();
testBrowserPanelAvoidsStalePreviewAndSlowFetchJank();
testBrowserPanelShowsCodexStyleLoadingAndEmptyState();
testBrowserPanelRequiresExplicitPageAttachment();

console.log("browser panel tests passed");
