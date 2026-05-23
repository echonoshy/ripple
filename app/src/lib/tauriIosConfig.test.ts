import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { scripts: Record<string, string> };
const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")
) as {
  identifier: string;
  app: { security: { csp: string } };
  bundle: { icon: string[]; iOS: { infoPlist: string; minimumSystemVersion: string } };
};
const commonInfoPlist = readFileSync(
  new URL("../../src-tauri/Info.plist", import.meta.url),
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

function testPackageExposesIosTauriScripts() {
  assert.equal(packageJson.scripts["tauri:ios:init"], "tauri ios init");
  assert.equal(packageJson.scripts["tauri:ios:dev"], "tauri ios dev");
  assert.equal(
    packageJson.scripts["tauri:ios:build:testflight"],
    "tauri ios build --export-method release-testing"
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

  assert.equal(tauriConfig.identifier, "ai.weilai.ripple");
  assert.match(csp, /connect-src[^;]*http:\/\/140\.143\.229\.103:8810/);
  assert.match(csp, /connect-src[^;]*https:\/\/test-oauth\.weilai\.ai/);
  assert.match(csp, /img-src[^;]*asset:/);
  assert.match(csp, /img-src[^;]*blob:/);
  assert.match(csp, /img-src[^;]*http:\/\/140\.143\.229\.103:8810/);
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
  assert.match(androidGradle, /manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"true"/);
}

testAndroidTargetHasBeenInitialized();

console.log("tauri mobile config tests passed");
