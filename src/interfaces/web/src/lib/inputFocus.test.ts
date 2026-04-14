import assert from "node:assert/strict";

import { bumpInputFocusToken, shouldApplyInputFocus } from "./inputFocus";

function testShouldApplyInputFocusOnlyWhenTokenIsBumpedAndInputIsEnabled() {
  assert.equal(shouldApplyInputFocus(0, false), false);
  assert.equal(shouldApplyInputFocus(1, true), false);
  assert.equal(shouldApplyInputFocus(1, false), true);
}

function testBumpInputFocusTokenIncrementsMonotonically() {
  assert.equal(bumpInputFocusToken(0), 1);
  assert.equal(bumpInputFocusToken(4), 5);
}

testShouldApplyInputFocusOnlyWhenTokenIsBumpedAndInputIsEnabled();
testBumpInputFocusTokenIncrementsMonotonically();

console.log("inputFocus tests passed");
