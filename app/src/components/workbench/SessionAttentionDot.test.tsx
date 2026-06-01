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

function testAttentionDotsUseVividStatusColors() {
  const completed = renderToStaticMarkup(<SessionAttentionDot attention="completed" />);
  const needsInput = renderToStaticMarkup(<SessionAttentionDot attention="needs_input" />);
  const error = renderToStaticMarkup(<SessionAttentionDot attention="error" />);

  assert.match(completed, /bg-\[#22c55e\]/);
  assert.match(completed, /ring-\[#22c55e\]\/28/);
  assert.match(needsInput, /bg-\[#f59e0b\]/);
  assert.match(needsInput, /ring-\[#f59e0b\]\/28/);
  assert.match(error, /bg-\[#ef4444\]/);
  assert.match(error, /ring-\[#ef4444\]\/28/);
}

testHidesEmptyAttentionWithoutReservedSpace();
testRendersAccessibleAttentionDot();
testAttentionDotsUseVividStatusColors();

console.log("session attention dot tests passed");
