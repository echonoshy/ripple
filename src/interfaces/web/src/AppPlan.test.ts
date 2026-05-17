import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function testChatCompletionClearsResidualPlan() {
  assert.match(source, /clearTaskPlanState/);
  assert.match(source, /onComplete:[\s\S]*clearTaskPlanState/);
}

function testTaskDetailsRestorePersistedPlan() {
  assert.match(source, /details\.task_steps/);
  assert.match(source, /details\.task_progress/);
}

testChatCompletionClearsResidualPlan();
testTaskDetailsRestorePersistedPlan();

console.log("app plan tests passed");
