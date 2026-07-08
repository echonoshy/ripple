import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./nativeBrowser.ts", import.meta.url), "utf8");

function testNativeBrowserUsesTauriInvokeBridge() {
  assert.match(source, /isNativeBrowserAvailable/);
  assert.match(source, /createNativeBrowserSurface/);
  assert.match(source, /invoke\("plugin:ripple-browser\|open"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|resize"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|navigate"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|reload"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|back"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|forward"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|capture"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|close"/);
}

function testNativeBrowserTracksViewportRectAndVisibility() {
  assert.match(source, /ResizeObserver/);
  assert.match(source, /getBoundingClientRect/);
  assert.match(source, /window\.addEventListener\("resize"/);
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(source, /intersectionRatio/);
}

function testNativeBrowserOnlyRunsInTauriRuntime() {
  assert.doesNotMatch(source, /ENABLE_NATIVE_BROWSER_SURFACE/);
  assert.doesNotMatch(source, /inline child WebView disabled/);
  assert.match(source, /return isTauriRuntime\(\)/);
  assert.match(source, /typeof window === "undefined"/);
  assert.match(source, /return false/);
}

function testNativeBrowserSurfaceExposesHistoryControls() {
  assert.match(source, /goBack: \(\) => Promise<void>/);
  assert.match(source, /goForward: \(\) => Promise<void>/);
  assert.match(source, /async goBack\(\)/);
  assert.match(source, /async goForward\(\)/);
}

testNativeBrowserUsesTauriInvokeBridge();
testNativeBrowserTracksViewportRectAndVisibility();
testNativeBrowserOnlyRunsInTauriRuntime();
testNativeBrowserSurfaceExposesHistoryControls();

console.log("native browser tests passed");
