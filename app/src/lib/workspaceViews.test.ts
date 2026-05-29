import assert from "node:assert/strict";

import { mainNavItems, shouldShowInspector, viewTitle } from "./workspaceViews";

function testMainNavItemsExposeRealWorkspaceViews() {
  assert.deepEqual(
    mainNavItems.map((item) => item.id),
    ["sessions", "files", "connectors", "automations", "system", "home"]
  );
}

function testViewTitlesAreHumanReadable() {
  assert.equal(viewTitle("home"), "Settings");
  assert.equal(viewTitle("sessions"), "Sessions");
  assert.equal(viewTitle("automations"), "Automations");
  assert.equal(viewTitle("files"), "Files");
  assert.equal(viewTitle("connectors"), "Connectors");
  assert.equal(viewTitle("system"), "System");
}

function testInspectorOnlyAppearsForSessionWorkbench() {
  assert.equal(shouldShowInspector("sessions"), true);
  assert.equal(shouldShowInspector("home"), false);
  assert.equal(shouldShowInspector("automations"), false);
  assert.equal(shouldShowInspector("files"), false);
  assert.equal(shouldShowInspector("connectors"), false);
  assert.equal(shouldShowInspector("system"), false);
}

testMainNavItemsExposeRealWorkspaceViews();
testViewTitlesAreHumanReadable();
testInspectorOnlyAppearsForSessionWorkbench();

console.log("workspaceViews tests passed");
