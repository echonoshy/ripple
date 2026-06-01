import assert from "node:assert/strict";

import { mainNavItems, mobileNavItems, shouldShowInspector, viewTitle } from "./workspaceViews";

function testMainNavItemsExposeDesktopProductTabs() {
  assert.deepEqual(
    mainNavItems.map((item) => item.id),
    ["sessions", "files", "automations", "connectors"]
  );
}

function testMobileNavKeepsSettingsEntry() {
  assert.deepEqual(
    mobileNavItems.map((item) => item.id),
    ["sessions", "files", "automations", "connectors", "home"]
  );
}

function testViewTitlesAreHumanReadable() {
  assert.equal(viewTitle("home"), "Settings");
  assert.equal(viewTitle("sessions"), "Sessions");
  assert.equal(viewTitle("automations"), "Automations");
  assert.equal(viewTitle("files"), "Files");
  assert.equal(viewTitle("connectors"), "Connectors");
}

function testInspectorOnlyAppearsForSessionWorkbench() {
  assert.equal(shouldShowInspector("sessions"), true);
  assert.equal(shouldShowInspector("home"), false);
  assert.equal(shouldShowInspector("automations"), false);
  assert.equal(shouldShowInspector("files"), false);
  assert.equal(shouldShowInspector("connectors"), false);
}

testMainNavItemsExposeDesktopProductTabs();
testMobileNavKeepsSettingsEntry();
testViewTitlesAreHumanReadable();
testInspectorOnlyAppearsForSessionWorkbench();

console.log("workspaceViews tests passed");
