import assert from "node:assert/strict";
import {
  SESSION_RAIL_DEFAULT_WIDTH,
  clampSessionRailWidth,
  isMobileLayoutWidth,
  normalizeWorkspaceFolderPath,
  readInitialSessionRailCollapsed,
  readInitialSessionRailWidth,
  shouldEnableAndroidChatBackGesture,
} from "./workbenchLayout";

function testSessionRailWidthBounds() {
  assert.equal(clampSessionRailWidth(100), 220);
  assert.equal(clampSessionRailWidth(301.6), 302);
  assert.equal(clampSessionRailWidth(600), 420);
  assert.equal(
    readInitialSessionRailWidth(() => null),
    SESSION_RAIL_DEFAULT_WIDTH
  );
  assert.equal(
    readInitialSessionRailWidth(() => "360.2"),
    360
  );
  assert.equal(
    readInitialSessionRailWidth(() => "nope"),
    SESSION_RAIL_DEFAULT_WIDTH
  );
  assert.equal(
    readInitialSessionRailCollapsed(() => "true"),
    true
  );
  assert.equal(
    readInitialSessionRailCollapsed(() => "false"),
    false
  );
}

function testMobileLayoutThreshold() {
  assert.equal(isMobileLayoutWidth(1023), true);
  assert.equal(isMobileLayoutWidth(1024), false);
}

function testWorkspaceFolderNormalization() {
  assert.equal(normalizeWorkspaceFolderPath(" /workspace/foo/ "), "/workspace/foo");
  assert.equal(normalizeWorkspaceFolderPath("/workspace"), "/workspace");
  assert.equal(normalizeWorkspaceFolderPath("/tmp"), "/workspace");
  assert.equal(normalizeWorkspaceFolderPath(""), "/workspace");
}

function testAndroidBackGestureScope() {
  assert.equal(
    shouldEnableAndroidChatBackGesture({
      authState: "authenticated",
      activeView: "sessions",
      mobileSessionMode: "chat",
      isSkillsMobileBackGestureActive: false,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldEnableAndroidChatBackGesture({
      authState: "authenticated",
      activeView: "skills",
      mobileSessionMode: "list",
      isSkillsMobileBackGestureActive: true,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldEnableAndroidChatBackGesture({
      authState: "authenticated",
      activeView: "skills",
      mobileSessionMode: "list",
      isSkillsMobileBackGestureActive: false,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldEnableAndroidChatBackGesture({
      authState: "authenticated",
      activeView: "sessions",
      mobileSessionMode: "chat",
      isSkillsMobileBackGestureActive: false,
      viewportWidth: 1024,
    }),
    false
  );
}

testSessionRailWidthBounds();
testMobileLayoutThreshold();
testWorkspaceFolderNormalization();
testAndroidBackGestureScope();

console.log("workbench layout tests passed");
