import assert from "node:assert/strict";

import {
  clearStoredCurrentSessionId,
  getStoredCurrentSessionId,
  pickInitialSessionId,
  pickRestorableSessionId,
  setStoredCurrentSessionId,
} from "./sessionPersistence";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

function makeSession(session_id: string): { session_id: string } {
  return { session_id };
}

function makeRecentSession(
  session_id: string,
  last_active: string
): {
  session_id: string;
  last_active: string;
} {
  return { session_id, last_active };
}

function testStorageRoundTrip() {
  const storage = new MemoryStorage();

  assert.equal(getStoredCurrentSessionId(storage), null);
  setStoredCurrentSessionId(storage, "srv-123");
  assert.equal(getStoredCurrentSessionId(storage), "srv-123");
  clearStoredCurrentSessionId(storage);
  assert.equal(getStoredCurrentSessionId(storage), null);
}

function testPickRestorableSessionIdRequiresStoredSessionInList() {
  const sessions = [makeSession("srv-111"), makeSession("srv-222")];

  assert.equal(pickRestorableSessionId("srv-222", sessions), "srv-222");
  assert.equal(pickRestorableSessionId("srv-999", sessions), null);
  assert.equal(pickRestorableSessionId(null, sessions), null);
}

function testPickInitialSessionIdPrefersStoredSession() {
  const sessions = [
    makeRecentSession("srv-older", "2026-05-17T00:00:00Z"),
    makeRecentSession("srv-newer", "2026-05-18T00:00:00Z"),
  ];

  assert.equal(pickInitialSessionId("srv-older", sessions), "srv-older");
}

function testPickInitialSessionIdFallsBackToMostRecentSession() {
  const sessions = [
    makeRecentSession("srv-older", "2026-05-17T00:00:00Z"),
    makeRecentSession("srv-newer", "2026-05-18T00:00:00Z"),
  ];

  assert.equal(pickInitialSessionId(null, sessions), "srv-newer");
  assert.equal(pickInitialSessionId("missing", sessions), "srv-newer");
  assert.equal(pickInitialSessionId(null, []), null);
}

testStorageRoundTrip();
testPickRestorableSessionIdRequiresStoredSessionInList();
testPickInitialSessionIdPrefersStoredSession();
testPickInitialSessionIdFallsBackToMostRecentSession();

console.log("sessionPersistence tests passed");
