import assert from "node:assert/strict";

import { sortModelOptions, formatModelName } from "./models";

function testSortsCodexPresetsByReasoningEffort() {
  const sorted = sortModelOptions([
    { id: "codex-xhigh", owned_by: "ripple" },
    { id: "codex-high", owned_by: "ripple" },
    { id: "custom-model", owned_by: "ripple" },
    { id: "codex-low", owned_by: "ripple" },
    { id: "codex-medium", owned_by: "ripple" },
  ]);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["codex-low", "codex-medium", "codex-high", "codex-xhigh", "custom-model"]
  );
}

function testKeepsUnknownModelsInBackendOrder() {
  const sorted = sortModelOptions([
    { id: "z-model", owned_by: "ripple" },
    { id: "a-model", owned_by: "ripple" },
  ]);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["z-model", "a-model"]
  );
}

function testFormatModelNameKnown() {
  assert.equal(formatModelName("codex-low"), "Lite");
  assert.equal(formatModelName("codex-medium"), "Plus");
  assert.equal(formatModelName("codex-high"), "Pro");
  assert.equal(formatModelName("codex-xhigh"), "Ultra");
}

function testFormatModelNameFallback() {
  assert.equal(formatModelName("custom-model"), "custom-model");
  assert.equal(formatModelName(""), "");
}

testSortsCodexPresetsByReasoningEffort();
testKeepsUnknownModelsInBackendOrder();
testFormatModelNameKnown();
testFormatModelNameFallback();

console.log("model sorting tests passed");
