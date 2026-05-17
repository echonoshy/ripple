import assert from "node:assert/strict";

import {
  getActiveMentionTrigger,
  getQuickActionMatches,
  getSlashCommandTrigger,
  removeMentionToken,
} from "./composerTriggers";

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

function testMentionTriggerReadsCurrentAtTokenOnly() {
  assert.deepEqual(getActiveMentionTrigger("@src", 4), {
    query: "src",
    token: "@src",
    start: 0,
    end: 4,
    key: "0:@src",
  });
  assert.deepEqual(getActiveMentionTrigger("inspect @TaskComposer", 21), {
    query: "TaskComposer",
    token: "@TaskComposer",
    start: 8,
    end: 21,
    key: "8:@TaskComposer",
  });
  assert.equal(getActiveMentionTrigger("email@example.com", 8), null);
  assert.equal(getActiveMentionTrigger("@ hello", 1), null);
}

function testRemoveMentionTokenCleansInsertedSearchText() {
  assert.equal(removeMentionToken("inspect @TaskComposer please", 8, 21), "inspect please");
  assert.equal(removeMentionToken("@TaskComposer", 0, 13), "");
  assert.equal(removeMentionToken("inspect @TaskComposer", 8, 21), "inspect");
}

testSlashCommandTriggersOnlyAtStartOfFirstLine();
testQuickActionMatchesUsePrefixAndFuzzySearch();
testMentionTriggerReadsCurrentAtTokenOnly();
testRemoveMentionTokenCleansInsertedSearchText();

console.log("composer trigger tests passed");
