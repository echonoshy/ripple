import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function testDefaultModelStateIsSeparateFromCurrentSessionModel() {
  assert.match(appSource, /const \[defaultModel, setDefaultModel\]/);
  assert.match(appSource, /onSelectedModelChange:\s*setSelectedModel/);
  assert.doesNotMatch(appSource, /onSelectedModelChange:\s*handleSelectModel/);
}

function testDefaultModelSeedsNewSessions() {
  assert.match(appSource, /createNewSession\(defaultModel(?:,\s*activeContextFolderPath)?\)/);
  assert.match(appSource, /defaultModel=\{defaultModel\}/);
  assert.match(appSource, /onSelectDefaultModel=\{handleSelectDefaultModel\}/);
}

testDefaultModelStateIsSeparateFromCurrentSessionModel();
testDefaultModelSeedsNewSessions();

console.log("app model preference tests passed");
