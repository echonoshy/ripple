import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chatRunSource = readFileSync(new URL("./hooks/useChatRun.ts", import.meta.url), "utf8");

function testChatCompletionClearsResidualPlan() {
  assert.match(chatRunSource, /clearPlanState/);
  assert.match(chatRunSource, /onComplete:[\s\S]*clearPlanState/);
}

function testSessionDetailsRestorePersistedPlan() {
  assert.match(chatRunSource, /details\.planSteps/);
  assert.match(chatRunSource, /details\.planProgress/);
}

function testRestoringSessionRefreshesWorkspaceViews() {
  assert.match(appSource, /const handleWorkspaceRefresh = useCallback\(\(\) => \{/);
  assert.match(appSource, /setWorkspaceRefreshToken\(\(prev\) => prev \+ 1\)/);
  assert.match(appSource, /onWorkspaceRefresh:\s*handleWorkspaceRefresh/);
  assert.match(chatRunSource, /applySessionDetails[\s\S]*onWorkspaceRefresh/);
}

function testAuthInitEffectDoesNotDependOnInlineCallbacks() {
  assert.match(
    appSource,
    /const getSessionActions = useCallback\(\(\) => sessionActionsRef\.current, \[\]\)/
  );
  assert.doesNotMatch(appSource, /onWorkspaceRefresh:\s*\(\)\s*=>/);
  assert.doesNotMatch(appSource, /getSessionActions:\s*\(\)\s*=>/);
}

function testAppDelegatesSessionLifecycle() {
  assert.match(appSource, /useSessionLifecycle/);
  assert.doesNotMatch(
    appSource,
    /import\s*\{[\s\S]*createSession[\s\S]*fetchSessions[\s\S]*fetchSessionDetails[\s\S]*deleteSession[\s\S]*stopSession[\s\S]*clearSessionContext[\s\S]*\}\s*from\s*"@\/lib\/api"/
  );
}

function testAppDelegatesChatRun() {
  assert.match(appSource, /useChatRun/);
  assert.doesNotMatch(appSource, /sendChatMessage/);
  assert.doesNotMatch(appSource, /uploadWorkspaceAttachment/);
}

testChatCompletionClearsResidualPlan();
testSessionDetailsRestorePersistedPlan();
testRestoringSessionRefreshesWorkspaceViews();
testAuthInitEffectDoesNotDependOnInlineCallbacks();
testAppDelegatesSessionLifecycle();
testAppDelegatesChatRun();

console.log("app plan tests passed");
