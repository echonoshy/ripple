import assert from "node:assert/strict";

import {
  initialLoginUserIdInput,
  loginUserIdValidationMessage,
  normalizeLoginUserId,
} from "./authLogin";

function testEmptyLoginUserIdFallsBackToDefault() {
  assert.equal(normalizeLoginUserId(""), "default");
  assert.equal(normalizeLoginUserId("   "), "default");
}

function testLoginUserIdTrimsCustomValues() {
  assert.equal(normalizeLoginUserId("  alice_dev  "), "alice_dev");
}

function testInvalidLoginUserIdShowsValidationMessage() {
  assert.equal(loginUserIdValidationMessage(""), null);
  assert.equal(loginUserIdValidationMessage("valid-user_1"), null);
  assert.match(loginUserIdValidationMessage("bad user") || "", /letters, numbers/);
}

function testDefaultUserIdStartsAsEmptyOptionalInput() {
  assert.equal(initialLoginUserIdInput("default"), "");
  assert.equal(initialLoginUserIdInput("alice"), "alice");
}

testEmptyLoginUserIdFallsBackToDefault();
testLoginUserIdTrimsCustomValues();
testInvalidLoginUserIdShowsValidationMessage();
testDefaultUserIdStartsAsEmptyOptionalInput();

console.log("auth login tests passed");
