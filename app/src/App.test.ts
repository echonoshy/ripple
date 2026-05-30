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

  assert.match(source, /window\.innerWidth < 1024/);
  assert.match(source, /setActiveView\("files"\)/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /new CustomEvent\("open-workspace-file"/);
}

function testMobileFileLinkRouteCanReturnToChat() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /mobileFilesReturnToChat/);
  assert.match(source, /setMobileFilesReturnToChat\(true\)/);
  assert.match(source, /handleReturnFromMobileFiles/);
  assert.match(source, /setMobileSessionMode\("chat"\)/);
  assert.match(source, /onBack=\{mobileFilesReturnToChat \? handleReturnFromMobileFiles : undefined\}/);
}

function testMobileFileLinkReturnRestoresSessionScroll() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /mobileSessionRestoreScrollTop/);
  assert.match(source, /data-ripple-session-scroll="timeline"/);
  assert.match(source, /setMobileSessionRestoreScrollTop\(scrollContainer\?\.scrollTop \?\? 0\)/);
  assert.match(source, /restoreScrollTop=\{mobileSessionRestoreScrollTop\}/);
  assert.match(source, /onRestoreScrollComplete=\{\(\) => setMobileSessionRestoreScrollTop\(null\)\}/);
}

testLoginScreenIncludesOptionalUserIdInput();
testWorkspaceLinksRouteToFilesPageOnMobile();
testMobileFileLinkRouteCanReturnToChat();
testMobileFileLinkReturnRestoresSessionScroll();

console.log("app tests passed");
