const CURRENT_SESSION_STORAGE_KEY = "ripple-current-session-id";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SessionRef = { session_id: string; last_active?: string };

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
  sessions: SessionRef[]
): string | null {
  if (!storedSessionId) {
    return null;
  }

  return sessions.some((session) => session.session_id === storedSessionId)
    ? storedSessionId
    : null;
}

export function pickInitialSessionId(
  storedSessionId: string | null,
  sessions: SessionRef[]
): string | null {
  const stored = pickRestorableSessionId(storedSessionId, sessions);
  if (stored) {
    return stored;
  }

  const latest = [...sessions].sort((a, b) => {
    const aTime = Date.parse(a.last_active || "");
    const bTime = Date.parse(b.last_active || "");
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  })[0];

  return latest?.session_id || null;
}
