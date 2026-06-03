import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const launcherIconSvg = readFileSync(
  new URL("../../../../assets/ripple-launcher-icon.svg", import.meta.url),
  "utf8"
);
const rippleIconAsset = JSON.parse(
  readFileSync(new URL("./rippleIconAsset.json", import.meta.url), "utf8")
) as { version: string };
const mobileSessionsSource = readFileSync(
  new URL("../workbench/MobileSessionsPage.tsx", import.meta.url),
  "utf8"
);

function testLauncherIconBackgroundIsRounded() {
  const backgroundRect = launcherIconSvg.match(/<rect\b[^>]*>/)?.[0] ?? "";

  assert.match(backgroundRect, /\brx="112"/);
  assert.match(backgroundRect, /\bry="112"/);
}

function testRoundedIconAssetVersionBustsFaviconCache() {
  assert.match(rippleIconAsset.version, /-rounded-r1$/);
}

function testMobileSessionsHeaderUsesRoundedLogo() {
  assert.match(
    mobileSessionsSource,
    /<RippleIcon size=\{28\} className="h-7 w-7 shrink-0 rounded-lg" \/>/
  );
}

testLauncherIconBackgroundIsRounded();
testRoundedIconAssetVersionBustsFaviconCache();
testMobileSessionsHeaderUsesRoundedLogo();

console.log("ripple icon asset tests passed");
