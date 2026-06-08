import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function testMobileSwipeBackDoesNotTriggerOuterPageTransition() {
  assert.match(
    appSource,
    /const mobileMotionStage = activeView === "sessions" \? "sessions:page" : `\$\{activeView\}:page`;/
  );
  assert.match(appSource, /key=\{mobileMotionStage\}/);
  assert.doesNotMatch(appSource, /mobileMotionStage[\s\S]*mobileSessionMode/);
  assert.doesNotMatch(appSource, /mobileMotionStage[\s\S]*isSkillsMobileBackGestureActive/);
}

function testSessionSwipeBackOnlyChangesStackModeInsideStableSessionsPage() {
  const openListBlock =
    appSource.match(/const handleOpenMobileSessionList = useCallback\(\(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0] ||
    "";

  assert.match(openListBlock, /setActiveView\("sessions"\)/);
  assert.match(openListBlock, /setMobileSessionMode\("list"\)/);
  assert.doesNotMatch(openListBlock, /setActiveView\("files"\)/);
  assert.doesNotMatch(openListBlock, /setActiveView\("skills"\)/);
}

function testAndroidBackGestureScopeStaysInsideActiveDetailSurfaces() {
  assert.match(appSource, /activeView === "sessions" && mobileSessionMode === "chat"/);
  assert.match(
    appSource,
    /\(activeView === "skills" \|\| activeView === "connectors"\) && isSkillsMobileBackGestureActive/
  );
  assert.match(appSource, /setAndroidChatBackGestureEnabled\(shouldEnable\)/);
}

testMobileSwipeBackDoesNotTriggerOuterPageTransition();
testSessionSwipeBackOnlyChangesStackModeInsideStableSessionsPage();
testAndroidBackGestureScopeStaysInsideActiveDetailSurfaces();

console.log("app mobile gesture tests passed");
