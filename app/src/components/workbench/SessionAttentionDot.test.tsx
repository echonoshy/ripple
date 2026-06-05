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

  assert.match(completed, /bg-\[#22A06B\]/);
  assert.match(completed, /ring-\[#22A06B\]\/28/);
  assert.match(needsInput, /bg-\[#D99900\]/);
  assert.match(needsInput, /ring-\[#D99900\]\/28/);
  assert.match(error, /bg-\[#B42318\]/);
  assert.match(error, /ring-\[#B42318\]\/28/);
}

testHidesEmptyAttentionWithoutReservedSpace();
testRendersAccessibleAttentionDot();
testAttentionDotsUseVividStatusColors();

console.log("session attention dot tests passed");
