import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function testModelSelectionAppliesToCurrentSessionAndDefault() {
  assert.match(appSource, /const \[defaultModel, setDefaultModel\]/);
  assert.match(appSource, /const selectedModelOverrideBySessionRef = useRef<Record<string, string>>/);
  assert.match(appSource, /const rememberSelectedModelOverride = useCallback/);
  assert.match(
    appSource,
    /const handleSelectModel = useCallback\([\s\S]*setSelectedModel\(model\);[\s\S]*rememberSelectedModelOverride\(model\);[\s\S]*persistDefaultModel\(model\);/
  );
  assert.match(
    appSource,
    /const handleSelectDefaultModel = useCallback\([\s\S]*persistDefaultModel\(model\);[\s\S]*setSelectedModel\(model\);[\s\S]*rememberSelectedModelOverride\(model\);/
  );
}

function testSessionDetailsRespectCurrentSessionModelOverride() {
  assert.match(appSource, /const handleSessionDetailModelChange = useCallback/);
  assert.match(appSource, /selectedModelOverrideBySessionRef\.current\[targetSessionId\]/);
  assert.match(appSource, /onSelectedModelChange:\s*handleSessionDetailModelChange/);
  assert.doesNotMatch(appSource, /onSelectedModelChange:\s*setSelectedModel/);
}

function testDefaultModelSeedsNewSessions() {
  assert.match(appSource, /createNewSession\(defaultModel(?:,\s*activeContextFolderPath)?\)/);
  assert.match(appSource, /defaultModel=\{defaultModel\}/);
  assert.match(appSource, /onSelectDefaultModel=\{handleSelectDefaultModel\}/);
}

testModelSelectionAppliesToCurrentSessionAndDefault();
testSessionDetailsRespectCurrentSessionModelOverride();
testDefaultModelSeedsNewSessions();

console.log("app model preference tests passed");
