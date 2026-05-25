import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chatRunSource = readFileSync(new URL("./hooks/useChatRun.ts", import.meta.url), "utf8");
const sessionLifecycleSource = readFileSync(
  new URL("./hooks/useSessionLifecycle.ts", import.meta.url),
  "utf8"
);

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

function testNewSessionCreationDoesNotDependOnGlobalGenerationState() {
  const createNewSessionBlock =
    sessionLifecycleSource.match(
      /const createNewSession = useCallback\([\s\S]*?\n\s{2}const switchSession = useCallback/
    )?.[0] || "";

  assert.doesNotMatch(createNewSessionBlock, /isGenerating/);
}

function testStopRefreshesSessionsAfterInterrupt() {
  const handleStopBlock =
    chatRunSource.match(
      /const handleStop = useCallback\([\s\S]*?\n\s{2}const handleClearContext = useCallback/
    )?.[0] || "";

  assert.match(handleStopBlock, /getSessionActions\(\)\.loadSessions\(\)/);
}

function testCompactSchedulesDelayedSessionRefreshes() {
  const clearBlock =
    chatRunSource.match(
      /const handleClearContext = useCallback\([\s\S]*?\n\s{2}const handleCompactContext = useCallback/
    )?.[0] || "";
  const compactBlock =
    chatRunSource.match(
      /const handleCompactContext = useCallback\([\s\S]*?\n\s{2}const handleAttachFiles = useCallback/
    )?.[0] || "";

  assert.doesNotMatch(clearBlock, /window\.setTimeout/);
  assert.match(compactBlock, /window\.setTimeout/);
}

function testStopTargetsOneRunningSession() {
  const handleStopBlock =
    chatRunSource.match(
      /const handleStop = useCallback\([\s\S]*?\n\s{2}const handleClearContext = useCallback/
    )?.[0] || "";

  assert.match(handleStopBlock, /abortControllersRef\.current\.get\(targetSessionId\)\?\.abort/);
  assert.match(handleStopBlock, /runningViewStatesRef\.current\.delete\(targetSessionId\)/);
  assert.match(handleStopBlock, /getSessionActions\(\)\.stopSession\(targetSessionId\)/);
}

function testChatSendIsNotBlockedByAnotherRunningSession() {
  const handleSendBlock =
    chatRunSource.match(
      /const handleSendMessage = useCallback\([\s\S]*?\n\s{2}const handleQuickReply = useCallback/
    )?.[0] || "";

  assert.doesNotMatch(handleSendBlock, /\|\|\s*isGenerating/);
  assert.doesNotMatch(
    appSource,
    /isComposerBlocked\s*=\s*Boolean\(isGenerating\s*&&\s*runningSessionId\s*!==\s*sessionId\)/
  );
}

function testChatRunStoresActiveRunsBySession() {
  assert.match(
    chatRunSource,
    /runningViewStatesRef\s*=\s*useRef<[^>]*Map<string,\s*ChatRunViewState>/
  );
  assert.match(
    chatRunSource,
    /abortControllersRef\s*=\s*useRef<[^>]*Map<string,\s*AbortController>/
  );
  assert.match(chatRunSource, /runningSessionIds/);
}

testChatCompletionClearsResidualPlan();
testSessionDetailsRestorePersistedPlan();
testRestoringSessionRefreshesWorkspaceViews();
testAuthInitEffectDoesNotDependOnInlineCallbacks();
testAppDelegatesSessionLifecycle();
testAppDelegatesChatRun();
testNewSessionCreationDoesNotDependOnGlobalGenerationState();
testStopRefreshesSessionsAfterInterrupt();
testCompactSchedulesDelayedSessionRefreshes();
testStopTargetsOneRunningSession();
testChatSendIsNotBlockedByAnotherRunningSession();
testChatRunStoresActiveRunsBySession();

console.log("app plan tests passed");
