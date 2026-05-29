import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AutomationsPage from "./AutomationsPage";

const noop = () => {};

function renderAutomationsPage() {
  return renderToStaticMarkup(
    <AutomationsPage selectedModel="codex-medium" onAuthExpired={noop} onBack={noop} />
  );
}

function testAutomationsPageHasMobileBackNavigation() {
  const html = renderAutomationsPage();

  assert.match(html, />Automations</);
  assert.match(html, /aria-label="Back to settings"/);
  assert.match(html, /lg:hidden/);
}

function testAutomationActionsUseVisibleDistinctLabels() {
  const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

  assert.match(source, />Pause</);
  assert.match(source, />Resume</);
  assert.match(source, />Run now</);
  assert.match(source, />Delete</);
}

testAutomationsPageHasMobileBackNavigation();
testAutomationActionsUseVisibleDistinctLabels();

console.log("automations page tests passed");
