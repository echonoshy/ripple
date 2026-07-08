import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { scripts: Record<string, string>; dependencies: Record<string, string> };
const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")
) as {
  identifier: string;
  app: {
    security: { csp: string };
    windows: Array<{ label: string; disableInputAccessoryView?: boolean }>;
  };
  bundle: { icon: string[]; iOS: { infoPlist: string; minimumSystemVersion: string } };
};
const tauriIosConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.ios.conf.json", import.meta.url), "utf8")
) as {
  identifier: string;
  build: { beforeDevCommand: string; beforeBuildCommand: string };
};
const commonInfoPlist = readFileSync(
  new URL("../../src-tauri/Info.plist", import.meta.url),
  "utf8"
);
const appleProjectConfig = readFileSync(
  new URL("../../src-tauri/gen/apple/project.yml", import.meta.url),
  "utf8"
);
const iosPlatformInfoPlist = readFileSync(
  new URL("../../src-tauri/Info.ios.plist", import.meta.url),
  "utf8"
);
const generatedIosInfoPlist = readFileSync(
  new URL("../../src-tauri/gen/apple/ripple-desktop_iOS/Info.plist", import.meta.url),
  "utf8"
);
const generatedIosProject = readFileSync(
  new URL("../../src-tauri/gen/apple/project.yml", import.meta.url),
  "utf8"
);
const androidGradle = readFileSync(
  new URL("../../src-tauri/gen/android/app/build.gradle.kts", import.meta.url),
  "utf8"
);
const androidManifest = readFileSync(
  new URL("../../src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url),
  "utf8"
);
const androidMainActivity = readFileSync(
  new URL(
    "../../src-tauri/gen/android/app/src/main/java/com/viaim/ripple/MainActivity.kt",
    import.meta.url
  ),
  "utf8"
);
const mainCapability = JSON.parse(
  readFileSync(new URL("../../src-tauri/capabilities/main.json", import.meta.url), "utf8")
) as { permissions: string[] };

function testPackageExposesIosTauriScripts() {
  assert.equal(packageJson.scripts["tauri:ios:init"], "tauri ios init");
  assert.equal(packageJson.scripts["tauri:ios:dev"], "tauri ios dev");
  assert.equal(
    packageJson.scripts["tauri:ios:build:testflight"],
    "tauri ios build --export-method app-store-connect"
  );
}

testPackageExposesIosTauriScripts();

function testPackageExposesAndroidTauriScripts() {
  assert.equal(packageJson.scripts["tauri:android:init"], "tauri android init");
  assert.equal(packageJson.scripts["tauri:android:dev"], "tauri android dev");
  assert.equal(packageJson.scripts["tauri:android:build"], "tauri android build");
}

testPackageExposesAndroidTauriScripts();

function testTauriConfigKeepsTemporaryHttpIpApiAndAssetCsp() {
  const csp = tauriConfig.app.security.csp;

  assert.equal(tauriConfig.identifier, "com.viaim.ripple");
  assert.match(csp, /connect-src[^;]*http:\/\/140\.143\.229\.103:8810/);
  assert.match(csp, /connect-src[^;]*https:\/\/test-oauth\.weilai\.ai/);
  assert.match(csp, /img-src[^;]*asset:/);
  assert.match(csp, /img-src[^;]*blob:/);
  assert.match(csp, /img-src[^;]*http:\/\/140\.143\.229\.103:8810/);
  assert.match(csp, /worker-src[^;]*'self'/);
  assert.match(csp, /worker-src[^;]*blob:/);
  assert.deepEqual(tauriConfig.bundle.icon, [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ]);
  assert.equal(tauriConfig.bundle.iOS.infoPlist, "Info.plist");
  assert.equal(tauriConfig.bundle.iOS.minimumSystemVersion, "14.0");
}

testTauriConfigKeepsTemporaryHttpIpApiAndAssetCsp();

function testTauriIosWindowDisablesKeyboardAccessoryBar() {
  const mainWindow = tauriConfig.app.windows.find((window) => window.label === "main");

  assert.equal(mainWindow?.disableInputAccessoryView, true);
}

testTauriIosWindowDisablesKeyboardAccessoryBar();

function testTauriOpenerCanOpenExternalAuthorizationUrls() {
  assert.match(mainCapability.permissions.join(" "), /opener:allow-open-url/);
  assert.match(mainCapability.permissions.join(" "), /opener:allow-default-urls/);
}

testTauriOpenerCanOpenExternalAuthorizationUrls();

function testTauriNativeBrowserCommandsArePermissioned() {
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-open/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-resize/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-navigate/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-reload/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-capture/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-close/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-show/);
  assert.match(mainCapability.permissions.join(" "), /ripple-browser:allow-hide/);
  assert.doesNotMatch(JSON.stringify(mainCapability), /"remote"/);
}

testTauriNativeBrowserCommandsArePermissioned();

function testPackagePinsPdfJsForMobilePreview() {
  assert.equal(packageJson.dependencies["pdfjs-dist"], "4.8.69");
}

testPackagePinsPdfJsForMobilePreview();

function testTauriIosDevUsesPublicRippleServer() {
  assert.equal(tauriIosConfig.identifier, "com.viaim.ripple");
  assert.match(appleProjectConfig, /PRODUCT_NAME: Ripple/);
  assert.match(appleProjectConfig, /PRODUCT_BUNDLE_IDENTIFIER: com\.viaim\.ripple/);
  assert.match(
    tauriIosConfig.build.beforeDevCommand,
    /VITE_RIPPLE_API_URL=http:\/\/140\.143\.229\.103:8810/
  );
  assert.match(
    tauriIosConfig.build.beforeBuildCommand,
    /VITE_RIPPLE_API_URL=http:\/\/140\.143\.229\.103:8810/
  );
}

testTauriIosDevUsesPublicRippleServer();

function testAppleInfoPlistsAllowTemporaryHttpIpApi() {
  assert.match(commonInfoPlist, /ITSAppUsesNonExemptEncryption/);
  assert.match(commonInfoPlist, /<false\/>/);
  assert.match(commonInfoPlist, /NSAppTransportSecurity/);
  assert.match(commonInfoPlist, /NSAllowsArbitraryLoads/);
  assert.match(iosPlatformInfoPlist, /ITSAppUsesNonExemptEncryption/);
  assert.match(iosPlatformInfoPlist, /<false\/>/);
  assert.match(iosPlatformInfoPlist, /NSAppTransportSecurity/);
  assert.match(iosPlatformInfoPlist, /NSAllowsArbitraryLoads/);
  assert.match(generatedIosInfoPlist, /ITSAppUsesNonExemptEncryption/);
  assert.match(generatedIosInfoPlist, /<false\/>/);
  assert.match(generatedIosInfoPlist, /NSAppTransportSecurity/);
  assert.match(generatedIosInfoPlist, /NSAllowsArbitraryLoads/);
  assert.match(generatedIosProject, /NSAppTransportSecurity/);
  assert.match(generatedIosProject, /NSAllowsArbitraryLoads:\s*true/);
}

testAppleInfoPlistsAllowTemporaryHttpIpApi();

function testAndroidTargetHasBeenInitialized() {
  assert.equal(
    existsSync(new URL("../../src-tauri/gen/android/app/build.gradle.kts", import.meta.url)),
    true
  );
  assert.equal(existsSync(new URL("../../src-tauri/gen/android/gradlew", import.meta.url)), true);
  assert.match(androidGradle, /namespace\s*=\s*"com\.viaim\.ripple"/);
  assert.match(androidGradle, /applicationId\s*=\s*"com\.viaim\.ripple"/);
  assert.match(androidGradle, /manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"true"/);
}

testAndroidTargetHasBeenInitialized();

function testAndroidChatActivityUsesResizeImeMode() {
  assert.match(androidManifest, /android:windowSoftInputMode="adjustResize"/);
}

testAndroidChatActivityUsesResizeImeMode();

function testAndroidMainActivityExposesChatBackGestureExclusionBridge() {
  assert.match(androidMainActivity, /package com\.viaim\.ripple/);
  assert.match(androidMainActivity, /override fun onWebViewCreate\(webView: WebView\)/);
  assert.match(
    androidMainActivity,
    /addJavascriptInterface\(RippleAndroidGestureBridge\(\), "RippleAndroidGesture"\)/
  );
  assert.match(androidMainActivity, /@JavascriptInterface/);
  assert.match(androidMainActivity, /fun setChatBackGestureEnabled\(enabled: Boolean\)/);
  assert.match(androidMainActivity, /runOnUiThread/);
  assert.match(androidMainActivity, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.Q/);
  assert.match(androidMainActivity, /systemGestureExclusionRects/);
  assert.match(androidMainActivity, /96 \* resources\.displayMetrics\.density/);
  assert.doesNotMatch(androidMainActivity, /48 \* resources\.displayMetrics\.density/);
  assert.match(androidMainActivity, /Rect\(0, 0, width, webView\.height\)/);
}

testAndroidMainActivityExposesChatBackGestureExclusionBridge();

function testAndroidMainActivityDoesNotForceWebViewDebugging() {
  assert.doesNotMatch(androidMainActivity, /setWebContentsDebuggingEnabled\(true\)/);
}

testAndroidMainActivityDoesNotForceWebViewDebugging();

console.log("tauri mobile config tests passed");
