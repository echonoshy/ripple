import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function testLoginScreenIncludesOptionalUserIdInput() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(source, /User ID/);
  assert.match(source, /placeholder="default"/);
  assert.match(source, /normalizeLoginUserId/);
  assert.match(source, /setUserId\(nextUserId\)/);
}

testLoginScreenIncludesOptionalUserIdInput();

console.log("app tests passed");
