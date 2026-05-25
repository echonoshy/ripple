import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionAttentionDot from "./SessionAttentionDot";

function testHidesEmptyAttentionWithoutReservedSpace() {
  const html = renderToStaticMarkup(<SessionAttentionDot attention={null} />);

  assert.equal(html, "");
}

function testRendersAccessibleAttentionDot() {
  const html = renderToStaticMarkup(<SessionAttentionDot attention="completed" />);

  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="New result"/);
  assert.doesNotMatch(html, />New result</);
}

testHidesEmptyAttentionWithoutReservedSpace();
testRendersAccessibleAttentionDot();

console.log("session attention dot tests passed");
