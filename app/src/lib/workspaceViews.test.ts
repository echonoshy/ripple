import assert from "node:assert/strict";

import { mainNavItems, mobileNavItems, shouldShowInspector, viewTitle } from "./workspaceViews";

function testMainNavItemsExposeDesktopProductTabs() {
  assert.deepEqual(
    mainNavItems.map((item) => item.id),
    ["sessions", "tasks", "files", "skills", "automations"]
  );
}

function testMobileNavKeepsSettingsEntry() {
  assert.deepEqual(
    mobileNavItems.map((item) => item.id),
    ["sessions", "tasks", "files", "skills", "automations", "home"]
  );
}

function testViewTitlesAreHumanReadable() {
  assert.equal(viewTitle("home"), "Settings");
  assert.equal(viewTitle("sessions"), "Sessions");
  assert.equal(viewTitle("tasks"), "Tasks");
  assert.equal(viewTitle("automations"), "Autos");
  assert.equal(viewTitle("files"), "Files");
  assert.equal(viewTitle("skills"), "Skills");
  assert.equal(viewTitle("connectors"), "Skills");
}

function testInspectorOnlyAppearsForSessionWorkbench() {
  assert.equal(shouldShowInspector("sessions"), true);
  assert.equal(shouldShowInspector("home"), false);
  assert.equal(shouldShowInspector("tasks"), false);
  assert.equal(shouldShowInspector("automations"), false);
  assert.equal(shouldShowInspector("files"), false);
  assert.equal(shouldShowInspector("skills"), false);
  assert.equal(shouldShowInspector("connectors"), false);
}

testMainNavItemsExposeDesktopProductTabs();
testMobileNavKeepsSettingsEntry();
testViewTitlesAreHumanReadable();
testInspectorOnlyAppearsForSessionWorkbench();

console.log("workspaceViews tests passed");
