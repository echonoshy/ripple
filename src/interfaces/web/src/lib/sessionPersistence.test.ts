import assert from "node:assert/strict";

import {
  clearStoredCurrentSessionId,
  getStoredCurrentSessionId,
  pickRestorableSessionId,
  setStoredCurrentSessionId,
} from "./sessionPersistence";
import type { Session } from "@/types";

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

function makeSession(session_id: string): Session {
  return {
    session_id,
    title: session_id,
    model: "sonnet",
    created_at: "2026-04-13T00:00:00+00:00",
    last_active: "2026-04-13T00:00:00+00:00",
    message_count: 3,
    status: "idle",
  };
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

testStorageRoundTrip();
testPickRestorableSessionIdRequiresStoredSessionInList();

console.log("sessionPersistence tests passed");
