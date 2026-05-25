import assert from "node:assert/strict";
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

testAutomationsPageHasMobileBackNavigation();

console.log("automations page tests passed");
