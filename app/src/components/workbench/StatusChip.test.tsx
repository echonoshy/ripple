import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import StatusChip from "./StatusChip";

function testHidesIdleStatus() {
  const html = renderToStaticMarkup(<StatusChip status="idle" compact />);

  assert.equal(html, "");
}

function testKeepsNonIdleStatus() {
  const html = renderToStaticMarkup(<StatusChip status="running" compact />);

  assert.match(html, />Running</);
}

testHidesIdleStatus();
testKeepsNonIdleStatus();

console.log("status chip tests passed");
