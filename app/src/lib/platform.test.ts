import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getClientStorage } from "./platform";

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

function testClientStorageHandlesUnavailableLocalStorage() {
  const globalWithWindow = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globalWithWindow.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.defineProperty({}, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    }),
  });

  try {
    assert.equal(getClientStorage(), null);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalWithWindow, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
}

test("platform browser integration", () => {
  testAndroidChatBackGestureUsesNativeBridgeWhenAvailable();
  testClientStorageHandlesUnavailableLocalStorage();
});
