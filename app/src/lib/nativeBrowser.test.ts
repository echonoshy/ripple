import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./nativeBrowser.ts", import.meta.url), "utf8");
const tauriBrowserSource = readFileSync(
  new URL("../../src-tauri/src/browser.rs", import.meta.url),
  "utf8"
);

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
  assert.doesNotMatch(source, /invoke\("plugin:ripple-browser\|print_page"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|set_zoom"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|clear_data"/);
  assert.match(source, /invoke\("plugin:ripple-browser\|close"/);
}

function testNativeBrowserReportsPageState() {
  assert.match(source, /title:\s*string \| null/);
  assert.match(source, /canGoBack:\s*boolean/);
  assert.match(source, /canGoForward:\s*boolean/);
  assert.match(source, /ripple-browser-state/);
  assert.match(source, /onStateChange/);
}

function testNativeBrowserTracksViewportRectAndVisibility() {
  assert.match(source, /ResizeObserver/);
  assert.match(source, /getBoundingClientRect/);
  assert.match(source, /window\.addEventListener\("resize"/);
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(source, /intersectionRatio/);
}

function testNativeBrowserOnlyRunsInTauriRuntime() {
  assert.doesNotMatch(source, /VITE_RIPPLE_NATIVE_BROWSER/);
  assert.doesNotMatch(source, /isNativeBrowserOptInEnabled/);
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

function testTauriBrowserUsesPersistentExternalWebviewStorage() {
  assert.match(tauriBrowserSource, /data_directory/);
  assert.match(tauriBrowserSource, /browser-data/);
  assert.doesNotMatch(tauriBrowserSource, /\.incognito\(true\)/);
}

function testTauriBrowserCreatesWebviewFromAsyncCommand() {
  assert.match(tauriBrowserSource, /async fn open/);
  assert.match(tauriBrowserSource, /add_child/);
}

function testTauriBrowserHandlesNormalBrowserEvents() {
  assert.match(tauriBrowserSource, /on_document_title_changed/);
  assert.match(tauriBrowserSource, /on_new_window/);
  assert.match(tauriBrowserSource, /on_download/);
  assert.match(tauriBrowserSource, /ripple-browser-state/);
  assert.match(tauriBrowserSource, /window\.history\.back\(\)/);
  assert.match(tauriBrowserSource, /window\.history\.forward\(\)/);
}

function testTauriBrowserExposesCodexStyleBasicPageTools() {
  assert.match(source, /setZoom: \(scale: number\) => Promise<void>/);
  assert.match(source, /clearData: \(\) => Promise<void>/);
  assert.doesNotMatch(source, /printPage: \(\) => Promise<void>/);
  assert.doesNotMatch(tauriBrowserSource, /fn print_page/);
  assert.doesNotMatch(tauriBrowserSource, /webview\.print\(\)/);
  assert.match(tauriBrowserSource, /fn set_zoom/);
  assert.match(tauriBrowserSource, /webview\.set_zoom/);
  assert.match(tauriBrowserSource, /fn clear_data/);
  assert.match(tauriBrowserSource, /webview\s*\.\s*clear_all_browsing_data/);
}

function testNativeBrowserSurfaceExposesAutomationCommand() {
  assert.match(
    source,
    /executeBrowserCommand: \(command: NativeBrowserCommand\) => Promise<NativeBrowserCommandResult>/
  );
  assert.match(source, /async executeBrowserCommand\(command: NativeBrowserCommand\)/);
  assert.match(source, /invoke\("plugin:ripple-browser\|run_automation"/);
  assert.match(tauriBrowserSource, /async fn run_automation/);
  assert.match(tauriBrowserSource, /browser_automation_script/);
}

testNativeBrowserUsesTauriInvokeBridge();
testNativeBrowserReportsPageState();
testNativeBrowserTracksViewportRectAndVisibility();
testNativeBrowserOnlyRunsInTauriRuntime();
testNativeBrowserSurfaceExposesHistoryControls();
testTauriBrowserUsesPersistentExternalWebviewStorage();
testTauriBrowserCreatesWebviewFromAsyncCommand();
testTauriBrowserHandlesNormalBrowserEvents();
testTauriBrowserExposesCodexStyleBasicPageTools();
testNativeBrowserSurfaceExposesAutomationCommand();

console.log("native browser tests passed");
