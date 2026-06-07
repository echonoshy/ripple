import { getClientStorage } from "@/lib/platform";

const CURRENT_SESSION_STORAGE_KEY = "ripple-current-session-id";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SessionRef = { sessionId: string; lastActiveAt?: string };

function getStorage(storage?: StorageLike): StorageLike | null {
  if (storage) {
    return storage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  return getClientStorage();
}

export function getStoredCurrentSessionId(storage?: StorageLike): string | null {
  try {
    return getStorage(storage)?.getItem(CURRENT_SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setStoredCurrentSessionId(
  storage: StorageLike | undefined,
  sessionId: string
): void {
  try {
    getStorage(storage)?.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId);
  } catch {
    /* Storage can be disabled or quota-limited in restricted browser contexts. */
  }
}

export function clearStoredCurrentSessionId(storage?: StorageLike): void {
  try {
    getStorage(storage)?.removeItem(CURRENT_SESSION_STORAGE_KEY);
  } catch {
    /* Storage can be disabled in restricted browser contexts. */
  }
}

export function pickRestorableSessionId(
  storedSessionId: string | null,
  sessions: SessionRef[]
): string | null {
  if (!storedSessionId) {
    return null;
  }

  return sessions.some((session) => session.sessionId === storedSessionId) ? storedSessionId : null;
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
    const aTime = Date.parse(a.lastActiveAt || "");
    const bTime = Date.parse(b.lastActiveAt || "");
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  })[0];

  return latest?.sessionId || null;
}
