import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const platformSource = readFileSync(new URL("./platform/index.ts", import.meta.url), "utf8");

function testAndroidChatBackGestureUsesNativeBridgeWhenAvailable() {
  assert.match(platformSource, /interface AndroidGestureWindow extends Window/);
  assert.match(platformSource, /RippleAndroidGesture/);
  assert.match(platformSource, /setAndroidChatBackGestureEnabled/);
  assert.match(platformSource, /isTauriRuntime\(\)/);
  assert.match(platformSource, /bridge\?\.setChatBackGestureEnabled/);
  assert.match(platformSource, /bridge\.setChatBackGestureEnabled\(enabled\)/);
  assert.doesNotMatch(platformSource, /listenForAndroidBackButton/);
  assert.doesNotMatch(platformSource, /AndroidBackButtonEvent/);
}

testAndroidChatBackGestureUsesNativeBridgeWhenAvailable();

console.log("platform tests passed");
