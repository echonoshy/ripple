import assert from "node:assert/strict";

import { getQuickActionMatches, getSlashCommandTrigger } from "./composerTriggers";

function testSlashCommandTriggersOnlyAtStartOfFirstLine() {
  assert.deepEqual(getSlashCommandTrigger("/", 1), { query: "", key: "/" });
  assert.deepEqual(getSlashCommandTrigger("/cl", 3), { query: "cl", key: "/cl" });
  assert.equal(getSlashCommandTrigger("please /cl", 10), null);
  assert.equal(getSlashCommandTrigger("/clear\nnext", 8), null);
}

function testQuickActionMatchesUsePrefixAndFuzzySearch() {
  assert.equal(getQuickActionMatches("").length, 1);
  assert.equal(getQuickActionMatches("cl")[0]?.id, "clear");
  assert.equal(getQuickActionMatches("cc")[0]?.id, "clear");
  assert.equal(getQuickActionMatches("zzz").length, 0);
}

testSlashCommandTriggersOnlyAtStartOfFirstLine();
testQuickActionMatchesUsePrefixAndFuzzySearch();

console.log("composer trigger tests passed");
