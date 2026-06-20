import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  mainNavItems,
  mobileNavItems,
  shouldShowInspector,
  viewTitle,
  type WorkspaceView,
} from "./workspaceViews";

function testMainNavItemsExposeDesktopProductTabs() {
  assert.deepEqual(
    mainNavItems.map((item) => item.id),
    ["sessions", "tasks", "files", "skills", "connectors"]
  );
}

function testMobileNavKeepsSettingsEntry() {
  assert.deepEqual(
    mobileNavItems.map((item) => item.id),
    ["sessions", "tasks", "files", "skills", "connectors", "home"]
  );
}

function testViewTitlesAreHumanReadable() {
  assert.equal(viewTitle("home"), "Settings");
  assert.equal(viewTitle("sessions"), "Sessions");
  assert.equal(viewTitle("tasks"), "Tasks");
  assert.equal(viewTitle("files"), "Files");
  assert.equal(viewTitle("skills"), "Skills");
  assert.equal(viewTitle("connectors"), "Connectors");
}

function testWorkspaceViewsExposeEveryPrimaryView() {
  const navIds = new Set(mainNavItems.map((item) => item.id));
  const primaryViews: WorkspaceView[] = ["sessions", "tasks", "files", "skills", "connectors"];

  for (const view of primaryViews) {
    assert.equal(navIds.has(view), true, `${view} is reachable from primary navigation`);
  }
}

function testInspectorOnlyAppearsForSessionWorkbench() {
  assert.equal(shouldShowInspector("sessions"), true);
  assert.equal(shouldShowInspector("home"), false);
  assert.equal(shouldShowInspector("tasks"), false);
  assert.equal(shouldShowInspector("files"), false);
  assert.equal(shouldShowInspector("skills"), false);
  assert.equal(shouldShowInspector("connectors"), false);
}

function testWorkspaceViewTypeDoesNotExposeAutomations() {
  const source = readFileSync(new URL("./workspaceViews.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\|\s*"automations"/);
}

testMainNavItemsExposeDesktopProductTabs();
testMobileNavKeepsSettingsEntry();
testViewTitlesAreHumanReadable();
testWorkspaceViewsExposeEveryPrimaryView();
testInspectorOnlyAppearsForSessionWorkbench();
testWorkspaceViewTypeDoesNotExposeAutomations();

console.log("workspaceViews tests passed");
