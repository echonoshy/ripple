import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS, createSettingsStore, isValidUserId, normalizeSettings } from "./settings";

test("validates Ripple user ids with the server character rules", () => {
  assert.equal(isValidUserId("default"), true);
  assert.equal(isValidUserId("lake_01"), true);
  assert.equal(isValidUserId("bad/user"), false);
  assert.equal(isValidUserId(""), false);
});

test("normalizes settings with mobile-safe defaults", () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({
      serverUrl: " http://192.168.1.8:8810/ ",
      apiKey: " key ",
      userId: " lake ",
      model: "codex-high",
      thinkingEnabled: true,
    }),
    {
      serverUrl: "http://192.168.1.8:8810",
      apiKey: "key",
      userId: "lake",
      model: "codex-high",
      thinkingEnabled: true,
    },
  );
  assert.equal(normalizeSettings({ userId: "bad/user" }).userId, "default");
});

test("settings store persists normalized settings through an async adapter", async () => {
  const memory = new Map<string, string>();
  const store = createSettingsStore({
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => {
      memory.set(key, value);
    },
    deleteItem: async (key) => {
      memory.delete(key);
    },
  });

  await store.save({
    serverUrl: " http://10.0.0.2:8810 ",
    apiKey: " dev ",
    userId: " lake ",
      model: "codex-medium",
    thinkingEnabled: false,
  });

  assert.deepEqual(await store.load(), {
    serverUrl: "http://10.0.0.2:8810",
    apiKey: "dev",
    userId: "lake",
    model: "codex-medium",
    thinkingEnabled: false,
  });

  await store.clear();
  assert.deepEqual(await store.load(), DEFAULT_SETTINGS);
});
