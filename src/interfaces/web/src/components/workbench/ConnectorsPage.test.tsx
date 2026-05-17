import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ConnectorsPage from "./ConnectorsPage";

function renderConnectorsPage() {
  return renderToStaticMarkup(<ConnectorsPage />);
}

function testConnectorsPageHasMobileSpecificCopy() {
  const html = renderConnectorsPage();

  assert.match(html, /sm:hidden[^>]*>Apps</);
  assert.match(html, /hidden sm:inline[^>]*>Connectors</);
  assert.match(html, /sm:hidden[^>]*>0\/0 ready</);
  assert.match(html, /hidden sm:inline[^>]*>0\/0 connected</);
  assert.match(html, /sm:hidden[^>]*>Sync</);
  assert.match(html, /hidden sm:inline[^>]*>Refresh</);
  assert.match(html, /sm:hidden[^>]*>No apps yet</);
  assert.match(html, /hidden sm:inline[^>]*>No connectors</);
}

testConnectorsPageHasMobileSpecificCopy();

console.log("connectors page tests passed");
