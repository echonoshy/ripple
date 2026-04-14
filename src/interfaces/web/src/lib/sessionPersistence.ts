import type { Session } from "@/types";

const CURRENT_SESSION_STORAGE_KEY = "ripple-current-session-id";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getStorage(storage?: StorageLike): StorageLike | null {
  if (storage) {
    return storage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

export function getStoredCurrentSessionId(storage?: StorageLike): string | null {
  return getStorage(storage)?.getItem(CURRENT_SESSION_STORAGE_KEY) ?? null;
}

export function setStoredCurrentSessionId(
  storage: StorageLike | undefined,
  sessionId: string
): void {
  getStorage(storage)?.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId);
}

export function clearStoredCurrentSessionId(storage?: StorageLike): void {
  getStorage(storage)?.removeItem(CURRENT_SESSION_STORAGE_KEY);
}

export function pickRestorableSessionId(
  storedSessionId: string | null,
  sessions: Session[]
): string | null {
  if (!storedSessionId) {
    return null;
  }

  return sessions.some((session) => session.session_id === storedSessionId)
    ? storedSessionId
    : null;
}
