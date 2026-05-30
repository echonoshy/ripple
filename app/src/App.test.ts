import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function testLoginScreenIncludesOptionalUserIdInput() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /User ID/);
  assert.match(source, /placeholder="default"/);
  assert.match(source, /normalizeLoginUserId/);
  assert.match(source, /setUserId\(nextUserId\)/);
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

testLoginScreenIncludesOptionalUserIdInput();
testWorkspaceLinksRouteToFilesPageOnMobile();
testWorkspaceLinksUsePendingRequestForCollapsedInspector();
testWorkspaceLinksIgnoreSandboxUserInProductSessionAuth();
testMobileFileLinkRouteCanReturnToChat();
testMobileFileLinkReturnRestoresSessionScroll();

console.log("app tests passed");
