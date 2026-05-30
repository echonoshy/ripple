import assert from "node:assert/strict";

import {
  getStoredDefaultModel,
  selectPreferredModel,
  setStoredDefaultModel,
} from "./modelPreference";

function withLocalStorage(run: () => void) {
  const globals = globalThis as unknown as { window?: { localStorage: Storage } };
  const previousWindow = globals.window;
  const values = new Map<string, string>();
  globals.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    },
  };

  try {
    run();
  } finally {
    globals.window = previousWindow;
  }
}

function testStoresDefaultModelPerUser() {
  withLocalStorage(() => {
    setStoredDefaultModel("lake", "codex-high");
    setStoredDefaultModel("default", "codex-low");

    assert.equal(getStoredDefaultModel("lake"), "codex-high");
    assert.equal(getStoredDefaultModel("default"), "codex-low");
  });
}

function testPreferredModelUsesStoredWhenAvailable() {
  assert.equal(
    selectPreferredModel(
      [
        { id: "codex-medium", owned_by: "ripple" },
        { id: "codex-high", owned_by: "ripple" },
      ],
      "codex-high"
    ),
    "codex-high"
  );
}

function testPreferredModelFallsBackToMediumThenFirstAvailable() {
  assert.equal(
    selectPreferredModel(
      [
        { id: "codex-low", owned_by: "ripple" },
        { id: "codex-medium", owned_by: "ripple" },
      ],
      "missing-model"
    ),
    "codex-medium"
  );

  assert.equal(
    selectPreferredModel([{ id: "custom-model", owned_by: "ripple" }], "missing-model"),
    "custom-model"
  );
}

testStoresDefaultModelPerUser();
testPreferredModelUsesStoredWhenAvailable();
testPreferredModelFallsBackToMediumThenFirstAvailable();

console.log("model preference tests passed");
