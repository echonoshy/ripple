import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chatRunSource = readFileSync(new URL("./hooks/useChatRun.ts", import.meta.url), "utf8");
const sessionPageSource = readFileSync(
  new URL("./components/workbench/SessionPage.tsx", import.meta.url),
  "utf8"
);
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

function testMobileUsesBottomTabBarForTopLevelViews() {
  assert.match(appSource, /import MobileTabBar/);
  assert.match(appSource, /mobileNav=\{mobileNav\}/);
  assert.match(appSource, /activeView === "sessions" && mobileSessionMode === "chat" \? null/);
}

function testSettingsIsSinglePageSurface() {
  assert.match(appSource, /import SettingsPage/);
  assert.doesNotMatch(appSource, /import SettingsModal/);
  assert.doesNotMatch(appSource, /isSettingsOpen/);
  assert.match(appSource, /activeView === "home"/);
  assert.match(appSource, /<SettingsPage/);
}

function testMobileChatHeaderOmitsSecondarySessionSettings() {
  assert.doesNotMatch(appSource, /handleOpenMobileSettings/);
  assert.doesNotMatch(appSource, /handleUpdateSessionSettings/);
  assert.match(appSource, /const handleOpenMobileSessionList = useCallback/);
  assert.match(appSource, /onBackToMobileSessions=\{handleOpenMobileSessionList\}/);
  assert.doesNotMatch(appSource, /onUpdateSessionSettings=/);
  assert.doesNotMatch(sessionPageSource, /aria-label=\{t\("sessions\.backToSession"\)\}/);
  assert.doesNotMatch(sessionPageSource, /t\("sessions\.settingsTitle"\)/);
}

function testSessionScrollActivationStaysInsideSessionPage() {
  assert.doesNotMatch(appSource, /scrollActivationKey/);
}

function testSessionSelectionRequestsScrollToBottom() {
  assert.match(appSource, /sessionScrollToBottomRequest/);
  assert.match(
    appSource,
    /if \(switched\) \{\s*acknowledgeSessionCompletion\(targetSessionId\);\s*setSessionScrollToBottomRequest\(\(request\) => request \+ 1\);/
  );
  assert.match(appSource, /scrollToBottomRequest=\{sessionScrollToBottomRequest\}/);
}

function testDefaultModelSeedsNewSessionsAndChatRuns() {
  assert.match(appSource, /createNewSession\(defaultModel(?:,\s*activeContextFolderPath)?\)/);
  assert.match(
    appSource,
    /ensureSession:\s*\(model\) => ensureSession\(model(?:,\s*activeContextFolderPath)?\)/
  );
  assert.match(chatRunSource, /getSessionActions\(\)\.ensureSession\(selectedModel\)/);
}

function testContextFolderSeedsNewSessionsAndFilesViewStaysPlain() {
  assert.match(appSource, /activeContextFolderPath/);
  assert.doesNotMatch(appSource, /fetchProjects/);
  assert.match(appSource, /createNewSession\(defaultModel,\s*activeContextFolderPath\)/);
  assert.match(
    appSource,
    /ensureSession:\s*\(model\) => ensureSession\(model,\s*activeContextFolderPath\)/
  );
  assert.doesNotMatch(appSource, /<FilesPage[\s\S]*projects=/);
  assert.doesNotMatch(appSource, /activeProjectId=/);
}

function testChatFolderPickerUpdatesCurrentSessionContextFolder() {
  assert.match(appSource, /handleSelectChatFolder/);
  assert.match(appSource, /nextContextFolderPath/);
  assert.match(
    appSource,
    /updateSessionById\(sessionId,\s*\{\s*contextFolderPath: nextContextFolderPath,\s*\}\)/
  );
  assert.doesNotMatch(appSource, /createProject/);
  assert.doesNotMatch(appSource, /window\.confirm/);
  assert.doesNotMatch(appSource, /setInput\(""\)/);
  assert.match(appSource, /onSelectWorkspaceFolder=\{handleSelectChatFolder\}/);
}

function testEmptyCurrentSessionIsNotInferredIntoSidebar() {
  assert.match(appSource, /const currentSessionShouldAppearInList =/);
  assert.match(
    appSource,
    /sessionId && !selectedExistingSession && currentSessionShouldAppearInList/
  );
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
testMobileUsesBottomTabBarForTopLevelViews();
testSettingsIsSinglePageSurface();
testMobileChatHeaderOmitsSecondarySessionSettings();
testSessionScrollActivationStaysInsideSessionPage();
testSessionSelectionRequestsScrollToBottom();
testDefaultModelSeedsNewSessionsAndChatRuns();
testContextFolderSeedsNewSessionsAndFilesViewStaysPlain();
testChatFolderPickerUpdatesCurrentSessionContextFolder();
testEmptyCurrentSessionIsNotInferredIntoSidebar();

console.log("app plan tests passed");
