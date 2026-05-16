import assert from "node:assert/strict";

import { mainNavItems, shouldShowInspector, viewTitle } from "./workspaceViews";

function testMainNavItemsExposeRealWorkspaceViews() {
  assert.deepEqual(
    mainNavItems.map((item) => item.id),
    ["home", "tasks", "files", "connectors"]
  );
}

function testViewTitlesAreHumanReadable() {
  assert.equal(viewTitle("home"), "Home");
  assert.equal(viewTitle("tasks"), "Tasks");
  assert.equal(viewTitle("files"), "Files");
  assert.equal(viewTitle("connectors"), "Connectors");
}

function testInspectorOnlyAppearsForTaskWorkbench() {
  assert.equal(shouldShowInspector("tasks"), true);
  assert.equal(shouldShowInspector("home"), false);
  assert.equal(shouldShowInspector("files"), false);
  assert.equal(shouldShowInspector("connectors"), false);
}

testMainNavItemsExposeRealWorkspaceViews();
testViewTitlesAreHumanReadable();
testInspectorOnlyAppearsForTaskWorkbench();

console.log("workspaceViews tests passed");
