import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const workbenchLayoutSource = readFileSync(
  new URL("./hooks/workbenchLayout.ts", import.meta.url),
  "utf8"
);

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
    appSource.match(
      /const handleOpenMobileSessionList = useCallback\(\(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/
    )?.[0] || "";

  assert.match(openListBlock, /setActiveView\("sessions"\)/);
  assert.match(openListBlock, /setMobileSessionMode\("list"\)/);
  assert.doesNotMatch(openListBlock, /setActiveView\("files"\)/);
  assert.doesNotMatch(openListBlock, /setActiveView\("skills"\)/);
}

function testSessionsUseStackTabBarUnderlayInsteadOfGlobalNav() {
  assert.match(appSource, /const sessionsMobileNav = \(/);
  assert.match(appSource, /listNav=\{sessionsMobileNav\}/);
  assert.match(
    appSource,
    /const mobileNav =\s*activeView === "sessions" \? null : \([\s\S]*<MobileTabBar/
  );
  assert.match(appSource, /placement="absolute"/);
  assert.doesNotMatch(appSource, /const isMobileNavHidden =/);
}

function testModelDropdownStateOnlyTracksComposer() {
  assert.match(
    appSource,
    /const \[openModelDropdown, setOpenModelDropdown\] = useState<"composer" \| null>\(null\);/
  );
  assert.doesNotMatch(appSource, /mobile-header/);
  assert.doesNotMatch(appSource, /enableMobileHeaderModelDropdown/);
  assert.match(appSource, /const mobileSessionChat = renderSessionPage\(\);/);
  assert.match(
    appSource,
    /<div className="h-full min-w-0 flex-1">\{renderSessionPage\(\)\}<\/div>/
  );
}

function testAndroidBackGestureScopeStaysInsideActiveDetailSurfaces() {
  assert.match(appSource, /useAndroidChatBackGesture\(\{/);
  assert.match(workbenchLayoutSource, /activeView === "sessions" && mobileSessionMode === "chat"/);
  assert.match(workbenchLayoutSource, /activeView === "skills" && isSkillsMobileBackGestureActive/);
  assert.doesNotMatch(workbenchLayoutSource, /activeView === "connectors"/);
  assert.match(workbenchLayoutSource, /setAndroidChatBackGestureEnabled\(/);
}

testMobileSwipeBackDoesNotTriggerOuterPageTransition();
testSessionSwipeBackOnlyChangesStackModeInsideStableSessionsPage();
testSessionsUseStackTabBarUnderlayInsteadOfGlobalNav();
testModelDropdownStateOnlyTracksComposer();
testAndroidBackGestureScopeStaysInsideActiveDetailSurfaces();

console.log("app mobile gesture tests passed");
