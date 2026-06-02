import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

  assert.match(source, /\? "relative flex h-full min-h-0 lg:flex"/);
  assert.match(source, /<div className="h-full min-w-0 flex-1">/);
}

function testMobileContentUsesSharedMotionTransitions() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ AnimatePresence, motion \} from "framer-motion"/);
  assert.match(source, /mobilePageVariants/);
  assert.match(source, /mobilePageTransition/);
  assert.match(source, /data-ripple-mobile-motion-stage=\{mobileMotionStage\}/);
  assert.match(source, /key=\{mobileMotionStage\}/);
  assert.match(source, /custom=\{mobileMotionDirection\}/);
  assert.match(source, /mode="wait"/);
}

function testCurrentSessionListVisibilityUsesRuntimeStatusPresence() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /Boolean\(selectedSessionRuntimeStatus\)/);
  assert.doesNotMatch(source, /selectedSessionRuntimeStatus !== "idle"/);
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

  assert.match(source, /SESSION_RAIL_WIDTH_STORAGE_KEY/);
  assert.match(source, /SESSION_RAIL_COLLAPSED_STORAGE_KEY/);
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

  assert.match(source, /data-ripple-panel-edge-handle="session-list"/);
  assert.match(
    source,
    /className="absolute top-1\/2 left-0[\s\S]*bg-white\/82[\s\S]*text-\[#007aff\]/
  );
  assert.doesNotMatch(
    source,
    /className="absolute top-1\/2 left-0[\s\S]*bg-\[#007aff\][\s\S]*text-white/
  );
  assert.doesNotMatch(source, /data-ripple-panel-edge-handle="session-list"[\s\S]*top-6/);
  assert.doesNotMatch(source, /top-\[14px\] left-4 z-30 hidden h-8/);
}

testAppUsesAuthGatewayForLoginScreen();
testWorkspaceLinksRouteToFilesPageOnMobile();
testWorkspaceLinksUsePendingRequestForCollapsedInspector();
testWorkspaceLinksIgnoreSandboxUserInProductSessionAuth();
testMobileFileLinkRouteCanReturnToChat();
testMobileFileLinkReturnRestoresSessionScroll();
testMobileChatSessionLayoutKeepsComposerPinned();
testMobileContentUsesSharedMotionTransitions();
testCurrentSessionListVisibilityUsesRuntimeStatusPresence();
testDesktopUsesProductTopBarWithSettingsAvatarEntry();
testSessionRailOnlyLivesInsideSessionsView();
testDesktopSessionRailCanResizeAndCollapse();
testCollapsedSessionRailUsesEdgeHandle();

console.log("app tests passed");
