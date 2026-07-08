import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chatRunSource = readFileSync(new URL("./hooks/useChatRun.ts", import.meta.url), "utf8");
const sessionPageSource = readFileSync(
  new URL("./components/workbench/SessionPage.tsx", import.meta.url),
  "utf8"
);
const contactsPageSource = readFileSync(
  new URL("./components/workbench/ContactsPage.tsx", import.meta.url),
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

function testAppLoadsAgentContactsForContactsPage() {
  assert.match(appSource, /fetchAgentContacts/);
  assert.match(appSource, /fetchAgentContactRequests/);
  assert.match(appSource, /createAgentContactRequest/);
  assert.match(appSource, /acceptAgentContactRequest/);
  assert.match(appSource, /removeAgentContact/);
  assert.match(appSource, /const \[agentContacts, setAgentContacts\]/);
  assert.match(
    appSource,
    /const \[receivedAgentContactRequests, setReceivedAgentContactRequests\]/
  );
  assert.match(appSource, /contacts=\{agentContacts\}/);
  assert.match(appSource, /receivedContactRequests=\{receivedAgentContactRequests\}/);
  assert.match(appSource, /onAddContact=\{handleAddAgentContact\}/);
  assert.match(appSource, /onAcceptContactRequest=\{handleAcceptAgentContactRequest\}/);
  assert.match(appSource, /onRemoveContact=\{handleRemoveAgentContact\}/);
  assert.doesNotMatch(sessionPageSource, /agentContacts\?: AgentContact\[\]/);
  assert.doesNotMatch(sessionPageSource, /AgentDelegationCreateDialog/);
  assert.doesNotMatch(sessionPageSource, /onCreateAgentDelegation=/);
}

function testAppRendersContactsAsTopLevelTaskEntry() {
  const contactsRenderBlock =
    appSource.match(
      /activeView === "contacts" \? \([\s\S]*?\n\s{4}\) : activeView === "skills"/
    )?.[0] || "";

  assert.match(
    appSource,
    /const ContactsPage = lazy\(\(\) => import\("@\/components\/workbench\/ContactsPage"\)\)/
  );
  assert.match(appSource, /activeView === "contacts"/);
  assert.match(appSource, /<ContactsPage/);
  assert.match(contactsRenderBlock, /contacts=\{agentContacts\}/);
  assert.match(contactsRenderBlock, /sentDelegations=\{sentAgentDelegations\}/);
  assert.match(contactsRenderBlock, /receivedDelegations=\{receivedAgentDelegations\}/);
  assert.match(
    contactsRenderBlock,
    /onCreateDelegation=\{handleCreateAgentDelegationFromContacts\}/
  );
  assert.match(contactsRenderBlock, /onOpenSession=\{handleOpenTaskSession\}/);
  assert.match(contactsRenderBlock, /onUpdateContact=\{handleUpdateAgentContact\}/);
  assert.match(contactsRenderBlock, /onRemoveContact=\{handleRemoveAgentContact\}/);
  assert.match(contactsPageSource, /data-ripple-contacts-page="true"/);
  assert.match(contactsPageSource, /onCreateDelegation/);
  assert.match(contactsPageSource, /onUpdateContact/);
  assert.doesNotMatch(contactsPageSource, /SessionComposer/);
}

function testAppWiresCollaborationChatsIntoSessions() {
  assert.match(appSource, /buildCollaborationSessionSummary/);
  assert.match(appSource, /selectedCollaborationSessionId/);
  assert.match(appSource, /displayWorkbenchSessionsWithCollaborations/);
  assert.match(appSource, /handleOpenCollaborationChat/);
  assert.match(appSource, /onOpenConversation=\{handleOpenCollaborationChat\}/);
  assert.match(appSource, /collaborationContext=/);
  assert.match(sessionPageSource, /collaborationContext\?: CollaborationContext \| null/);
}

function testContactDelegationCreatesRequesterSessionAfterCreate() {
  const createFromContactsBlock =
    appSource.match(
      /const handleCreateAgentDelegationFromContacts = useCallback\([\s\S]*?\n\s{2}const handleAcceptAgentDelegation = useCallback/
    )?.[0] || "";

  assert.match(createFromContactsBlock, /createNewSession\(defaultModel, activeContextFolderPath/);
  assert.doesNotMatch(
    createFromContactsBlock,
    /ensureSession\(defaultModel, activeContextFolderPath\)/
  );
  assert.match(createFromContactsBlock, /requesterSession\.sessionId/);
  assert.match(createFromContactsBlock, /setActiveView\("sessions"\)/);
  assert.match(createFromContactsBlock, /setMobileSessionMode\("chat"\)/);
  assert.match(createFromContactsBlock, /handleSwitchSession\(requesterSession\.sessionId\)/);
}

function testDelegationPollingRefreshesVisibleSessions() {
  const refreshDelegationsBlock =
    appSource.match(
      /const refreshAgentDelegations = useCallback\([\s\S]*?\n\s{2}useEffect\(\(\) => \{/
    )?.[0] || "";

  assert.match(refreshDelegationsBlock, /refreshSessionForDelegationUpdates/);
  assert.match(refreshDelegationsBlock, /requesterSessionId/);
  assert.match(refreshDelegationsBlock, /targetSessionId/);
}

function testTasksChatSchedulingUsesNewSessionPrompts() {
  const createScheduledTaskBlock =
    appSource.match(
      /const handleCreateScheduledTaskChat = useCallback\([\s\S]*?\n\s{2}const handleOpenSessionAction = useCallback/
    )?.[0] || "";
  const editScheduledTaskBlock =
    appSource.match(
      /const handleEditScheduledTaskChat = useCallback\([\s\S]*?\n\s{2}const handleOpenSessionAction = useCallback/
    )?.[0] || "";

  assert.match(createScheduledTaskBlock, /createNewSession\(defaultModel, activeContextFolderPath/);
  assert.match(createScheduledTaskBlock, /t\("tasks\.createWithChatPrompt"\)/);
  assert.match(editScheduledTaskBlock, /createNewSession\(defaultModel, activeContextFolderPath/);
  assert.match(editScheduledTaskBlock, /t\("tasks\.editWithChatPrompt"/);
  assert.match(editScheduledTaskBlock, /formatScheduledTaskTriggersForChat/);
  assert.match(appSource, /onCreateScheduledTaskChat=\{handleCreateScheduledTaskChat\}/);
  assert.match(appSource, /onEditScheduledTaskChat=\{handleEditScheduledTaskChat\}/);
}

function testNewSessionCreationDoesNotDependOnGlobalGenerationState() {
  const createNewSessionBlock =
    sessionLifecycleSource.match(
      /const createNewSession = useCallback\([\s\S]*?\n\s{2}const switchSession = useCallback/
    )?.[0] || "";

  assert.doesNotMatch(createNewSessionBlock, /isGenerating/);
}

function testNewSessionCreationOptimisticallyUpdatesSessionList() {
  const createNewSessionBlock =
    sessionLifecycleSource.match(
      /const createNewSession = useCallback\([\s\S]*?\n\s{2}const switchSession = useCallback/
    )?.[0] || "";

  assert.match(createNewSessionBlock, /setSessionSummaries\(\(prev\) =>/);
  assert.match(createNewSessionBlock, /session\.sessionId/);
  assert.match(createNewSessionBlock, /void loadSessions\(\{ showLoading: false \}\)/);
}

function testSwitchingCurrentSessionRefreshesDetails() {
  const switchSessionBlock =
    sessionLifecycleSource.match(
      /const switchSession = useCallback\([\s\S]*?\n\s{2}const deleteSessionById = useCallback/
    )?.[0] || "";
  assert.match(switchSessionBlock, /const details = await fetchSessionDetails\(targetSessionId\)/);
  assert.doesNotMatch(
    switchSessionBlock,
    /if \(targetSessionId === sessionId\) \{\s*onSessionActivated\(\);\s*return true;\s*\}/
  );
  assert.match(
    switchSessionBlock,
    /targetSessionId === sessionId && isGenerating/,
    "only an active generating session may skip the detail refresh"
  );
}

function testOpeningSessionsViewRefreshesCurrentSession() {
  const handleSelectViewBlock =
    appSource.match(
      /const handleSelectView = useCallback\([\s\S]*?\n\s{2}const handleReturnFromMobileFiles = useCallback/
    )?.[0] || "";

  assert.match(handleSelectViewBlock, /if \(view === "sessions"\) \{/);
  assert.match(handleSelectViewBlock, /sessionId/);
  assert.match(handleSelectViewBlock, /void handleSwitchSession\(sessionId\)/);
}

function testStopRefreshesSessionsAfterInterrupt() {
  const handleStopBlock =
    chatRunSource.match(
      /const handleStop = useCallback\([\s\S]*?\n\s{2}const handleClearContext = useCallback/
    )?.[0] || "";

  assert.match(handleStopBlock, /getSessionActions\(\)\.loadSessions\(\{ showLoading: false \}\)/);
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
  assert.match(appSource, /const sessionsMobileNav = \(/);
  assert.match(appSource, /placement="absolute"/);
  assert.match(appSource, /listNav=\{sessionsMobileNav\}/);
  assert.match(appSource, /const mobileNav =\s*activeView === "sessions" \? null : \(/);
  assert.doesNotMatch(appSource, /const isMobileNavHidden =/);
}

function testSettingsIsSinglePageSurface() {
  assert.match(
    appSource,
    /const SettingsPage = lazy\(\(\) => import\("@\/components\/workbench\/SettingsPage"\)\)/
  );
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
    /if \(switched\) \{\s*acknowledgeSessionAttention\(targetSessionId\);\s*setSessionScrollToBottomRequest\(\(request\) => request \+ 1\);/
  );
  assert.match(appSource, /scrollToBottomRequest=\{sessionScrollToBottomRequest\}/);
}

function testSessionSelectionAcknowledgesErrorAttention() {
  assert.match(appSource, /acknowledgeSessionAttention/);
  assert.match(appSource, /setAcknowledgedSessionAttentionById/);
  assert.match(appSource, /storedAttention === "error"/);
  assert.match(appSource, /summaryAttention === "error"/);
  assert.doesNotMatch(appSource, /acknowledgeSessionCompletion/);
}

function testDefaultModelSeedsNewSessionsAndChatRuns() {
  assert.match(
    appSource,
    /createNewSession\(defaultModel,\s*activeContextFolderPath,\s*\{\s*refresh: false,\s*\}\)/
  );
  assert.match(
    appSource,
    /ensureSession:\s*\(model\) => ensureSession\(model(?:,\s*activeContextFolderPath)?\)/
  );
  assert.match(
    chatRunSource,
    /const sessionActions = getSessionActions\(\);[\s\S]*sessionActions\.ensureSession\(selectedModel\)/
  );
}

function testContextFolderSeedsNewSessionsAndFilesViewStaysPlain() {
  assert.match(appSource, /activeContextFolderPath/);
  assert.doesNotMatch(appSource, /fetchProjects/);
  assert.match(
    appSource,
    /createNewSession\(defaultModel,\s*activeContextFolderPath,\s*\{\s*refresh: false,\s*\}\)/
  );
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
  assert.match(appSource, /updated\.contextFolderPath \?\? nextContextFolderPath/);
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

function testMobileSessionSelectionSlidesBeforeDetailsResolve() {
  const selectMobileSessionBlock =
    appSource.match(
      /const handleSelectMobileSession = useCallback\([\s\S]*?\n\s{2}const handleSelectChatFolder = useCallback/
    )?.[0] || "";

  assert.match(appSource, /pendingMobileSession/);
  assert.match(selectMobileSessionBlock, /setPendingMobileSession/);
  assert.match(
    selectMobileSessionBlock,
    /setMobileSessionMode\("chat"\)[\s\S]*await handleSwitchSession/
  );
  assert.match(appSource, /isMobileSessionSwitchPending/);
  assert.match(appSource, /isSessionLoading=\{isMobileSessionSwitchPending\}/);
}

function testPendingMobileSessionDoesNotRenderPreviousSessionContent() {
  assert.match(
    appSource,
    /const sessionPageMessages =\s*isMobileSessionSwitchPending \|\| isCollaborationChatActive \? \[\] : messages/
  );
  assert.match(
    appSource,
    /const sessionPageTimelineEvents =\s*isMobileSessionSwitchPending \|\| isCollaborationChatActive \? \[\] : timelineEvents/
  );
  assert.match(
    appSource,
    /const sessionPagePlanSteps =\s*isMobileSessionSwitchPending \|\| isCollaborationChatActive \? \[\] : planSteps/
  );
  assert.match(
    appSource,
    /const sessionPageTokenUsage =\s*isMobileSessionSwitchPending \|\| isCollaborationChatActive \? emptyUsage : tokenUsage/
  );
}

function testTopLevelMobileMotionDoesNotWaitThroughBlankFrame() {
  assert.match(appSource, /mobilePageSwitchTransition/);
  assert.doesNotMatch(
    appSource,
    /<AnimatePresence mode="wait" initial=\{false\} custom=\{mobileMotionDirection\}>/
  );
}

function testAppWiresBrowserContextIntoChatRun() {
  assert.match(appSource, /type ChatBrowserContext/);
  assert.match(appSource, /const \[browserContext, setBrowserContext\]/);
  assert.match(appSource, /const browserContextRef = useRef<ChatBrowserContext \| null>\(null\)/);
  assert.match(appSource, /getBrowserContext:\s*\(\) => browserContextRef\.current/);
  assert.match(appSource, /onBrowserContextChange=\{setBrowserContext\}/);
  assert.match(appSource, /browserCommandExecutorRef/);
  assert.match(
    appSource,
    /browserCommandExecutor:\s*\(request\) =>[\s\S]*browserCommandExecutorRef\.current\?\.\(request\)/
  );
  assert.match(appSource, /onBrowserCommandExecutorChange=\{handleBrowserCommandExecutorChange\}/);
}

testChatCompletionClearsResidualPlan();
testSessionDetailsRestorePersistedPlan();
testRestoringSessionRefreshesWorkspaceViews();
testAuthInitEffectDoesNotDependOnInlineCallbacks();
testAppDelegatesSessionLifecycle();
testAppDelegatesChatRun();
testAppLoadsAgentContactsForContactsPage();
testAppRendersContactsAsTopLevelTaskEntry();
testAppWiresCollaborationChatsIntoSessions();
testContactDelegationCreatesRequesterSessionAfterCreate();
testDelegationPollingRefreshesVisibleSessions();
testTasksChatSchedulingUsesNewSessionPrompts();
testNewSessionCreationDoesNotDependOnGlobalGenerationState();
testNewSessionCreationOptimisticallyUpdatesSessionList();
testSwitchingCurrentSessionRefreshesDetails();
testOpeningSessionsViewRefreshesCurrentSession();
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
testSessionSelectionAcknowledgesErrorAttention();
testDefaultModelSeedsNewSessionsAndChatRuns();
testContextFolderSeedsNewSessionsAndFilesViewStaysPlain();
testChatFolderPickerUpdatesCurrentSessionContextFolder();
testEmptyCurrentSessionIsNotInferredIntoSidebar();
testMobileSessionSelectionSlidesBeforeDetailsResolve();
testPendingMobileSessionDoesNotRenderPreviousSessionContent();
testTopLevelMobileMotionDoesNotWaitThroughBlankFrame();
testAppWiresBrowserContextIntoChatRun();

console.log("app plan tests passed");
