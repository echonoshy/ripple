import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chatRunSource = readFileSync(new URL("./hooks/useChatRun.ts", import.meta.url), "utf8");

function testChatCompletionClearsResidualPlan() {
  assert.match(chatRunSource, /clearTaskPlanState/);
  assert.match(chatRunSource, /onComplete:[\s\S]*clearTaskPlanState/);
}

function testSessionDetailsRestorePersistedPlan() {
  assert.match(chatRunSource, /details\.taskSteps/);
  assert.match(chatRunSource, /details\.taskProgress/);
}

function testRestoringSessionRefreshesWorkspaceViews() {
  assert.match(appSource, /onWorkspaceRefresh:\s*\(\)\s*=>\s*setWorkspaceRefreshToken/);
  assert.match(chatRunSource, /applySessionDetails[\s\S]*onWorkspaceRefresh/);
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
testAppDelegatesSessionLifecycle();
testAppDelegatesChatRun();

console.log("app plan tests passed");
