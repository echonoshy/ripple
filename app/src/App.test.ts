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
  assert.match(source, /onBack=\{mobileFilesReturnToChat \? handleReturnFromMobileFiles : undefined\}/);
}

function testMobileFileLinkReturnRestoresSessionScroll() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /mobileSessionRestoreScrollTop/);
  assert.match(source, /data-ripple-session-scroll="timeline"/);
  assert.match(source, /shouldReturnToSession \? \(scrollContainer\?\.scrollTop \?\? 0\) : null/);
  assert.match(source, /restoreScrollTop=\{mobileSessionRestoreScrollTop\}/);
  assert.match(source, /onRestoreScrollComplete=\{\(\) => setMobileSessionRestoreScrollTop\(null\)\}/);
}

testAppUsesAuthGatewayForLoginScreen();
testWorkspaceLinksRouteToFilesPageOnMobile();
testWorkspaceLinksUsePendingRequestForCollapsedInspector();
testWorkspaceLinksIgnoreSandboxUserInProductSessionAuth();
testMobileFileLinkRouteCanReturnToChat();
testMobileFileLinkReturnRestoresSessionScroll();

console.log("app tests passed");
