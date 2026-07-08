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
  assert.match(html, /aria-label="Attach current page"/);
  assert.match(html, /aria-label="Zoom out"/);
  assert.match(html, /aria-label="Zoom in"/);
  assert.doesNotMatch(html, /aria-label="Print page"/);
  assert.match(html, /aria-label="Clear browser data"/);
  assert.match(html, /aria-label="Open externally"/);
  assert.match(html, /data-ripple-browser-frame="true"/);
}

function testBrowserPanelBuildsAgentReadableContext() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /buildBrowserContext/);
  assert.match(source, /onBrowserContextChange\(context\.active \? context : null\)/);
  assert.match(source, /captureCurrentPage/);
  assert.doesNotMatch(source, /fetchBrowserPage/);
}

function testBrowserPanelKeepsNativeBrowserOutOfAgentContext() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /publishNativeBrowserState/);
  assert.match(source, /onBrowserContextChange\(null\)/);
  assert.doesNotMatch(source, /publishContext\(nativeUrl,\s*null\)/);
  assert.doesNotMatch(source, /publishContext\(event\.url,\s*null\)/);
}

function testBrowserPanelShowsUnsupportedStateOutsideTauri() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /browser\.desktopOnlyTitle/);
  assert.match(source, /browser\.desktopOnlySubtitle/);
  assert.doesNotMatch(source, /browser\.previewBlocked/);
}

function testBrowserPanelDoesNotRenderServerPreviewHtml() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /shouldUsePreviewHtml/);
  assert.doesNotMatch(source, /srcDoc=/);
  assert.doesNotMatch(source, /ripple-browser-navigate/);
  assert.doesNotMatch(source, /window\.addEventListener\("message"/);
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

function testBrowserPanelUsesNativeHistoryControls() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /nativeBrowserRef\.current\.goBack/);
  assert.match(source, /nativeBrowserRef\.current\.goForward/);
  assert.match(source, /nativeCanGoBack/);
  assert.match(source, /nativeCanGoForward/);
  assert.match(source, /if \(nativeBrowserAvailable && nativeBrowserRef\.current\)/);
}

function testBrowserPanelKeepsNavigationInsideApp() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /systemBrowserMode/);
  assert.doesNotMatch(source, /openInSystemBrowser/);
  assert.doesNotMatch(source, /openExternalUrl\(normalizedAddress,\s*"ripple-browser"\)/);
  assert.match(source, /void capturePage\(address\)/);
  assert.match(source, /nativeBrowserRef\.current\?\.navigate\(event\.url\)/);
}

function testBrowserPanelDoesNotDirectlyFrameHttpWebSites() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /isDirectBrowserIframeUrl/);
  assert.doesNotMatch(source, /shouldUseDirectIframe/);
  assert.doesNotMatch(source, /<iframe/);
}

function testBrowserPanelPreservesAgentReadableContextInNativeMode() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /publishContext\(event\.url,\s*null\)/);
  assert.doesNotMatch(
    source,
    /setPendingNavigationUrl\(null\);\s*return;\s*}\s*catch \(nativeError\)/
  );
}

function testBrowserPanelDoesNotFallBackToServerPreviewInNativeMode() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /catch \(nativeError\)[\s\S]*setStatus\("failed"\);[\s\S]*setError\(t\("browser\.failed"\)\);[\s\S]*return;/
  );
}

function testBrowserPanelAvoidsStalePreviewAndSlowFetchJank() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /latestCaptureIdRef/);
  assert.match(source, /setPendingNavigationUrl\(normalizedAddress \|\| null\)/);
  assert.doesNotMatch(source, /captureId !== latestCaptureIdRef\.current/);
  assert.doesNotMatch(source, /onLoad=\{handleFrameLoad\}/);
  assert.doesNotMatch(source, /setFrameVersion\(\(current\) => current \+ 1\)/);
}

function testBrowserPanelKeepsTypedAddressAsDraftUntilNavigation() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /const activeUrl = pendingNavigationUrl \|\| frameUrl;/);
  assert.doesNotMatch(source, /pendingNavigationUrl \|\| frameUrl \|\| address/);
}

function testBrowserPanelOpensFromEnterAndSearchButton() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /handleAddressKeyDown/);
  assert.match(source, /event\.key !== "Enter"/);
  assert.match(source, /void capturePage\(event\.currentTarget\.value\)/);
  assert.match(source, /onKeyDown=\{handleAddressKeyDown\}/);
  assert.match(source, /onClick=\{\(\) => void capturePage\(address\)\}/);
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
  assert.match(html, /Built-in browser is not supported on the web/);
}

function testBrowserPanelRequiresExplicitPageAttachment() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /browser\.attachCurrentPage/);
  assert.match(source, /browser\.attachedCurrentPage/);
  assert.match(source, /handleAttachCurrentPage/);
  assert.doesNotMatch(source, /handleNativePageLoad[\s\S]*publishContext\(event\.url,\s*null\)/);
}

function testBrowserPanelShowsDownloadStatusFromNativeEvents() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /lastDownload/);
  assert.match(source, /download-requested/);
  assert.match(source, /download-finished/);
  assert.match(source, /browser\.downloadStarted/);
  assert.match(source, /browser\.downloadFinished/);
}

function testBrowserPanelExposesUsefulPageTools() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /handleZoomOut/);
  assert.match(source, /handleZoomIn/);
  assert.match(source, /handleClearBrowserData/);
  assert.match(source, /nativeBrowserRef\.current\s*\.\s*setZoom/);
  assert.doesNotMatch(source, /handlePrintPage/);
  assert.doesNotMatch(source, /nativeBrowserRef\.current\.printPage/);
  assert.match(source, /nativeBrowserRef\.current\s*\.\s*clearData/);
}

function testBrowserPanelRegistersBrowserCommandExecutor() {
  const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /onBrowserCommandExecutorChange/);
  assert.match(source, /executeBrowserCommand/);
  assert.match(source, /onBrowserCommandExecutorChange\(null\)/);
}

testBrowserPanelRendersBrowserControls();
testBrowserPanelBuildsAgentReadableContext();
testBrowserPanelKeepsNativeBrowserOutOfAgentContext();
testBrowserPanelShowsUnsupportedStateOutsideTauri();
testBrowserPanelDoesNotRenderServerPreviewHtml();
testBrowserPanelUsesNativeTauriBrowserWhenAvailable();
testBrowserPanelUsesNativeHistoryControls();
testBrowserPanelKeepsNavigationInsideApp();
testBrowserPanelDoesNotDirectlyFrameHttpWebSites();
testBrowserPanelPreservesAgentReadableContextInNativeMode();
testBrowserPanelDoesNotFallBackToServerPreviewInNativeMode();
testBrowserPanelAvoidsStalePreviewAndSlowFetchJank();
testBrowserPanelKeepsTypedAddressAsDraftUntilNavigation();
testBrowserPanelOpensFromEnterAndSearchButton();
testBrowserPanelShowsCodexStyleLoadingAndEmptyState();
testBrowserPanelRequiresExplicitPageAttachment();
testBrowserPanelShowsDownloadStatusFromNativeEvents();
testBrowserPanelExposesUsefulPageTools();
testBrowserPanelRegistersBrowserCommandExecutor();

console.log("browser panel tests passed");
