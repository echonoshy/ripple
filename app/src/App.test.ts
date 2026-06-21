import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workbenchLayoutSource = readFileSync(
  new URL("./hooks/workbenchLayout.ts", import.meta.url),
  "utf8"
);

function testAppUsesAuthGatewayForLoginScreen() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /import AuthGateway, \{ type AuthGatewayMode \}/);
  assert.match(source, /<AuthGateway/);
  assert.match(source, /authUserIdInput=\{authUserIdInput\}/);
  assert.match(source, /onServiceAuth=\{handleAuthSubmit\}/);
  assert.match(source, /onPasswordLogin=\{handlePasswordLogin\}/);
  assert.match(source, /onInviteClaim=\{handleInviteClaim\}/);
  assert.match(source, /onModeChange=\{\(mode\) => \{/);
  assert.match(source, /normalizeLoginUserId/);
  assert.match(source, /setUserId\(nextUserId\)/);
  assert.doesNotMatch(source, /Sign in to your workspace/);
  assert.doesNotMatch(source, /grid grid-cols-3 rounded-lg/);
}

function testAuthModeChangesClearSensitiveInputs() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /setPasswordInput\(""\)/);
  assert.match(source, /setKeyInput\(""\)/);
  assert.match(source, /setInviteCodeInput\(""\)/);
  assert.match(source, /setInviteDisplayNameInput\(""\)/);
  assert.match(source, /setAuthUserIdInput\(initialLoginUserIdInput\(getUserId\(\)\)\)/);
  assert.match(source, /setAuthUserIdError\(t\("auth\.userIdInvalid"\)\)/);
}

function testWorkspaceLinksRouteToFilesPageOnMobile() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /window\.innerWidth >= 1280/);
  assert.match(source, /setActiveView\("files"\)/);
  assert.match(source, /setPendingWorkspaceFileOpen\(/);
  assert.match(source, /openFileRequest=\{pendingWorkspaceFileOpen\}/);
  assert.doesNotMatch(source, /requestAnimationFrame[\s\S]*new CustomEvent\("open-workspace-file"/);
}

function testWorkspaceLinksUsePendingRequestForCollapsedInspector() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /const canUseInspector/);
  assert.match(source, /setIsInspectorCollapsed\(false\)/);
  assert.match(source, /<InspectorPanel[\s\S]*openFileRequest=\{pendingWorkspaceFileOpen\}/);
}

function testWorkspaceLinksIgnoreSandboxUserInProductSessionAuth() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /const linkUserId = productSessionActive \? undefined : targetUserId/);
  assert.match(source, /userId: linkUserId/);
  assert.match(source, /if \(linkUserId && linkUserId !== userId\)/);
}

function testMobileFileLinkRouteCanReturnToChat() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /mobileFilesReturnToChat/);
  assert.match(source, /const shouldReturnToSession = activeViewRef\.current === "sessions"/);
  assert.match(source, /setMobileFilesReturnToChat\(shouldReturnToSession\)/);
  assert.match(source, /handleReturnFromMobileFiles/);
  assert.match(source, /setMobileSessionMode\("chat"\)/);
  assert.match(
    source,
    /onBack=\{mobileFilesReturnToChat \? handleReturnFromMobileFiles : undefined\}/
  );
}

function testMobileFileLinkReturnRestoresSessionScroll() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /mobileSessionRestoreScrollTop/);
  assert.match(source, /data-ripple-session-scroll="timeline"/);
  assert.match(source, /shouldReturnToSession \? \(scrollContainer\?\.scrollTop \?\? 0\) : null/);
  assert.match(source, /restoreScrollTop=\{mobileSessionRestoreScrollTop\}/);
  assert.match(
    source,
    /onRestoreScrollComplete=\{\(\) => setMobileSessionRestoreScrollTop\(null\)\}/
  );
}

function testMobileChatSessionLayoutKeepsComposerPinned() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /import MobileSessionStack/);
  assert.match(source, /<MobileSessionStack/);
  assert.match(source, /mode=\{mobileSessionMode\}/);
  assert.match(source, /list=\{mobileSessionList\}/);
  assert.match(source, /listNav=\{sessionsMobileNav\}/);
  assert.match(source, /chat=\{mobileSessionChat\}/);
  assert.match(source, /onOpenList=\{handleOpenMobileSessionList\}/);
}

function testDesktopSessionRailStillUsesSeparateLayout() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-session-layout="desktop"/);
  assert.match(source, /className="relative hidden h-full min-h-0 lg:flex"/);
  assert.match(source, /<WorkspaceNav[\s\S]*sessions=\{displayWorkbenchSessions\}/);
}

function testMobileContentUsesSharedMotionTransitions() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ AnimatePresence, motion \} from "framer-motion"/);
  assert.match(source, /mobilePageVariants/);
  assert.match(source, /mobilePageSwitchTransition/);
  assert.match(source, /data-ripple-mobile-motion-stage=\{mobileMotionStage\}/);
  assert.match(source, /key=\{mobileMotionStage\}/);
  assert.match(source, /custom=\{mobileMotionDirection\}/);
  assert.doesNotMatch(source, /<AnimatePresence mode="wait" initial=\{false\}/);
}

function testMobileSessionModeDoesNotRemountMotionStage() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const mobileMotionStageBlock = source.match(/const mobileMotionStage =[\s\S]*?;/)?.[0] || "";

  assert.match(mobileMotionStageBlock, /activeView === "sessions" \? "sessions:page"/);
  assert.doesNotMatch(mobileMotionStageBlock, /mobileSessionMode/);
}

function testCurrentSessionListVisibilityUsesRuntimeStatusPresence() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /Boolean\(selectedSessionRuntimeStatus\)/);
  assert.doesNotMatch(source, /selectedSessionRuntimeStatus !== "idle"/);
}

function testSessionSelectionAcknowledgesNeedsInputAttention() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const acknowledgeBlock =
    source.match(/const acknowledgeSessionAttention = useCallback\([\s\S]*?\n {2}\);/)?.[0] || "";

  assert.match(source, /sessionAttentionFromStatus/);
  assert.match(acknowledgeBlock, /summaryAttention/);
  assert.match(acknowledgeBlock, /storedAttention === "needs_input"/);
  assert.match(acknowledgeBlock, /summaryAttention === "needs_input"/);
  assert.match(acknowledgeBlock, /setAcknowledgedSessionAttentionById/);
}

function testMobileSessionListDoesNotHideSelectedSessionAttention() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const displaySessionsBlock =
    source.match(/const displayWorkbenchSessions = useMemo\([\s\S]*?\n {2}\);/)?.[0] || "";
  const attentionHandlerBlock =
    source.match(/const handleSessionAttention = useCallback\([\s\S]*?\n {2}\);/)?.[0] || "";

  assert.match(source, /const isMobileLayout = useMobileLayout\(\)/);
  assert.match(source, /const sessionDetailVisibleForAttention =/);
  assert.match(source, /!isMobileLayout \|\| mobileSessionMode === "chat"/);
  assert.match(
    source,
    /const openSessionIdForAttention = sessionDetailVisibleForAttention \? sessionId : null/
  );
  assert.match(displaySessionsBlock, /openSessionIdForAttention/);
  assert.doesNotMatch(displaySessionsBlock, /activeView === "sessions" \? sessionId : null/);
  assert.doesNotMatch(attentionHandlerBlock, /attention === "completed"/);
  assert.doesNotMatch(attentionHandlerBlock, /attention === "error"[\s\S]*sessionIsOpen/);
}

function testFreshSessionSendSkipsPreflightListRefresh() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /createNewSession\(model, activeContextFolderPath, \{ refresh: false \}\)/);
}

function testMobileNewSessionSkipsVisibleListRefresh() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /createNewSession\(defaultModel,\s*activeContextFolderPath,\s*\{\s*refresh: false,\s*\}\)/
  );
}

function testVisibleSessionListUsesStableOrderAcrossRefreshes() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const displaySessionsBlock =
    source.match(/const displayWorkbenchSessions = useMemo\([\s\S]*?\n {2}\);/)?.[0] || "";

  assert.match(source, /stabilizeWorkbenchSessionOrder/);
  assert.match(source, /displayWorkbenchSessionOrderRef/);
  assert.match(source, /const sessionListVisibleForStableOrder =/);
  assert.match(source, /mobileSessionMode === "list"/);
  assert.match(displaySessionsBlock, /stabilizeWorkbenchSessionOrder/);
}

function testDesktopUsesProductTopBarWithSettingsAvatarEntry() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /import ProductTopBar/);
  assert.match(source, /topBar=\{[\s\S]*<ProductTopBar/);
  assert.match(source, /onOpenSettings=\{\(\) => handleSelectView\("home"\)\}/);
  assert.doesNotMatch(source, /nav=\{[\s\S]*<WorkspaceNav/);
}

function testSessionRailOnlyLivesInsideSessionsView() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-session-layout="desktop"/);
  assert.match(source, /<WorkspaceNav[\s\S]*sessions=\{displayWorkbenchSessions\}/);
  assert.doesNotMatch(source, /activeView === "files"[\s\S]{0,240}<WorkspaceNav/);
}

function testDesktopSessionRailCanResizeAndCollapse() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(workbenchLayoutSource, /SESSION_RAIL_WIDTH_STORAGE_KEY/);
  assert.match(workbenchLayoutSource, /SESSION_RAIL_COLLAPSED_STORAGE_KEY/);
  assert.match(source, /handleSessionRailResizeStart/);
  assert.match(source, /aria-label=\{t\("common\.resizeSessionList"\)\}/);
  assert.match(source, /aria-valuemin=\{SESSION_RAIL_MIN_WIDTH\}/);
  assert.match(source, /aria-valuemax=\{SESSION_RAIL_MAX_WIDTH\}/);
  assert.match(source, /aria-valuenow=\{sessionRailWidth\}/);
  assert.match(source, /onCollapse=\{\(\) => setIsSessionRailCollapsed\(true\)\}/);
  assert.match(source, /aria-label=\{t\("common\.expandSessionList"\)\}/);
}

function testCollapsedSessionRailUsesEdgeHandle() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_ICON_BUTTON_CLASS/);
  assert.match(source, /data-ripple-panel-edge-handle="session-list"/);
  assert.match(
    source,
    /className=\{`absolute top-1\/2 left-0[\s\S]*\$\{WORKBENCH_ICON_BUTTON_CLASS\}/
  );
  assert.doesNotMatch(
    source,
    /data-ripple-panel-edge-handle="session-list"[\s\S]*backdrop-blur-xl/
  );
  assert.doesNotMatch(source, /data-ripple-panel-edge-handle="session-list"[\s\S]*bg-white\/82/);
  assert.doesNotMatch(
    source,
    /className="absolute top-1\/2 left-0[\s\S]*bg-\[#1456F0\][\s\S]*text-white/
  );
  assert.doesNotMatch(source, /data-ripple-panel-edge-handle="session-list"[\s\S]*top-6/);
  assert.doesNotMatch(source, /top-\[14px\] left-4 z-30 hidden h-8/);
}

function testAndroidBackGestureExclusionAppliesToMobileSwipeBackSurfaces() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /useAndroidChatBackGesture\(\{/);
  assert.match(workbenchLayoutSource, /setAndroidChatBackGestureEnabled/);
  assert.match(workbenchLayoutSource, /ANDROID_CHAT_BACK_GESTURE_DESKTOP_MIN_WIDTH_PX/);
  assert.match(source, /isSkillsMobileBackGestureActive/);
  assert.match(source, /setIsSkillsMobileBackGestureActive/);
  assert.match(source, /onMobileBackGestureScopeChange=\{setIsSkillsMobileBackGestureActive\}/);
  assert.match(workbenchLayoutSource, /authState === "authenticated"/);
  assert.match(workbenchLayoutSource, /const isMobileChatBackGestureActive =/);
  assert.match(workbenchLayoutSource, /const isMobileSkillsBackGestureActive =/);
  assert.match(workbenchLayoutSource, /isMobileLayoutWidth\(viewportWidth\)/);
  assert.match(workbenchLayoutSource, /shouldEnableAndroidChatBackGesture/);
  assert.match(
    workbenchLayoutSource,
    /window\.addEventListener\("resize", updateAndroidChatBackGesture\)/
  );
  assert.match(workbenchLayoutSource, /setAndroidChatBackGestureEnabled\(false\)/);
  assert.doesNotMatch(source, /listenForAndroidBackButton/);
  assert.doesNotMatch(source, /handleAndroidBackButton/);
  assert.doesNotMatch(source, /onBackButtonPress/);
}

function testAutomationsPageIsNotAWorkspaceView() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /AutomationsPage/);
  assert.doesNotMatch(source, /activeView === "automations"/);
}

function testTasksPageIsAFirstClassWorkspaceView() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const TasksPage = lazy\(\(\) => import\("@\/components\/workbench\/TasksPage"\)\)/
  );
  assert.match(source, /activeView === "tasks"/);
  assert.match(source, /<TasksPage[\s\S]*userId=\{userId\}/);
  assert.doesNotMatch(source, /activeView === "tasks" \|\| activeView === "connectors"/);
}

function testConnectorsPageIsNotAWorkspaceView() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /ConnectorsPage/);
  assert.doesNotMatch(source, /activeView === "connectors"/);
  assert.doesNotMatch(source, /<ConnectorsPage/);
  assert.doesNotMatch(source, /activeView === "skills" \|\| activeView === "connectors"/);
}

testAppUsesAuthGatewayForLoginScreen();
testAuthModeChangesClearSensitiveInputs();
testWorkspaceLinksRouteToFilesPageOnMobile();
testWorkspaceLinksUsePendingRequestForCollapsedInspector();
testWorkspaceLinksIgnoreSandboxUserInProductSessionAuth();
testMobileFileLinkRouteCanReturnToChat();
testMobileFileLinkReturnRestoresSessionScroll();
testMobileChatSessionLayoutKeepsComposerPinned();
testDesktopSessionRailStillUsesSeparateLayout();
testMobileContentUsesSharedMotionTransitions();
testMobileSessionModeDoesNotRemountMotionStage();
testCurrentSessionListVisibilityUsesRuntimeStatusPresence();
testSessionSelectionAcknowledgesNeedsInputAttention();
testMobileSessionListDoesNotHideSelectedSessionAttention();
testFreshSessionSendSkipsPreflightListRefresh();
testMobileNewSessionSkipsVisibleListRefresh();
testVisibleSessionListUsesStableOrderAcrossRefreshes();
testDesktopUsesProductTopBarWithSettingsAvatarEntry();
testSessionRailOnlyLivesInsideSessionsView();
testDesktopSessionRailCanResizeAndCollapse();
testCollapsedSessionRailUsesEdgeHandle();
testAndroidBackGestureExclusionAppliesToMobileSwipeBackSurfaces();
testAutomationsPageIsNotAWorkspaceView();
testTasksPageIsAFirstClassWorkspaceView();
testConnectorsPageIsNotAWorkspaceView();

console.log("app tests passed");
