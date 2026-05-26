import { useCallback, useState } from "react";
import type { SessionDetail, SessionSummary } from "@/types";
import {
  AuthError,
  clearSessionContext,
  compactSessionContext,
  createSession,
  deleteSession,
  fetchSessionDetails,
  fetchSessions,
  stopSession,
  updateSession,
  type SessionUpdateInput,
} from "@/lib/api";
import { readableApiErrorMessage } from "@/lib/apiErrors";
import {
  clearStoredCurrentSessionId,
  getStoredCurrentSessionId,
  pickInitialSessionId,
  setStoredCurrentSessionId,
} from "@/lib/sessionPersistence";

type AuthState = "checking" | "needs_auth" | "authenticated";

interface UseSessionLifecycleOptions {
  authState: AuthState;
  isGenerating: boolean;
  onAuthExpired: (message: string) => void;
  onApplySessionDetails: (details: SessionDetail) => void;
  onNewSessionView: () => void;
  onDeleteCurrentSession: () => void;
  onSessionActivated: () => void;
}

export function useSessionLifecycle({
  authState,
  isGenerating,
  onAuthExpired,
  onApplySessionDetails,
  onNewSessionView,
  onDeleteCurrentSession,
  onSessionActivated,
}: UseSessionLifecycleOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionSummaries, setSessionSummaries] = useState<SessionSummary[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);

  const handleAuthExpired = useCallback(
    (message = "API key 已失效") => {
      clearStoredCurrentSessionId();
      onAuthExpired(message);
    },
    [onAuthExpired]
  );

  const loadSessions = useCallback(async (): Promise<SessionSummary[]> => {
    if (authState !== "authenticated") return [];
    try {
      setIsLoadingSessions(true);
      setSessionLoadError(null);
      const loadedSessions = await fetchSessions();
      setSessionSummaries(loadedSessions);
      return loadedSessions;
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
        return [];
      }
      setSessionLoadError(readableApiErrorMessage(err));
      return [];
    } finally {
      setIsLoadingSessions(false);
    }
  }, [authState, handleAuthExpired]);

  const applySessionDetails = useCallback(
    (details: SessionDetail) => {
      setSessionId(details.sessionId);
      onApplySessionDetails(details);
      setStoredCurrentSessionId(undefined, details.sessionId);
    },
    [onApplySessionDetails]
  );

  const restoreStoredSession = useCallback(
    async (availableSessions: SessionSummary[]) => {
      const storedSessionId = getStoredCurrentSessionId();
      const restorableSessionId = pickInitialSessionId(storedSessionId, availableSessions);

      if (!restorableSessionId) {
        clearStoredCurrentSessionId();
        return;
      }

      const details = await fetchSessionDetails(restorableSessionId);
      if (!details) {
        clearStoredCurrentSessionId();
        return;
      }

      applySessionDetails(details);
    },
    [applySessionDetails]
  );

  const resetSessionsForUserChange = useCallback(() => {
    setSessionId(null);
    setSessionSummaries([]);
    setSessionLoadError(null);
    clearStoredCurrentSessionId();
  }, []);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    try {
      const session = await createSession();
      setSessionId(session.sessionId);
      setStoredCurrentSessionId(undefined, session.sessionId);
      return session.sessionId;
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
      }
      return null;
    }
  }, [handleAuthExpired, sessionId]);

  const createNewSession = useCallback(async (): Promise<SessionSummary | null> => {
    try {
      const session = await createSession();
      setSessionId(session.sessionId);
      setStoredCurrentSessionId(undefined, session.sessionId);
      onNewSessionView();
      onSessionActivated();
      await loadSessions();
      return session;
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
      }
      return null;
    }
  }, [handleAuthExpired, loadSessions, onNewSessionView, onSessionActivated]);

  const switchSession = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      if (targetSessionId === sessionId) {
        onSessionActivated();
        return true;
      }
      try {
        const details = await fetchSessionDetails(targetSessionId);
        if (!details) return false;
        applySessionDetails(details);
        onSessionActivated();
        return true;
      } catch (err) {
        console.error("Error switching session:", err);
        return false;
      }
    },
    [applySessionDetails, onSessionActivated, sessionId]
  );

  const deleteSessionById = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      if (isGenerating) return false;
      if (!(await deleteSession(targetSessionId))) return false;

      setSessionSummaries((prev) =>
        prev.filter((session) => session.sessionId !== targetSessionId)
      );
      if (getStoredCurrentSessionId() === targetSessionId) {
        clearStoredCurrentSessionId();
      }
      if (targetSessionId === sessionId) {
        setSessionId(null);
        onDeleteCurrentSession();
      }
      return true;
    },
    [isGenerating, onDeleteCurrentSession, sessionId]
  );

  const stopCurrentSession = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    return stopSession(sessionId);
  }, [sessionId]);

  const stopSessionById = useCallback(async (targetSessionId: string): Promise<boolean> => {
    return stopSession(targetSessionId);
  }, []);

  const updateSessionById = useCallback(
    async (targetSessionId: string, input: SessionUpdateInput): Promise<SessionSummary | null> => {
      try {
        const updatedSession = await updateSession(targetSessionId, input);
        setSessionSummaries((prev) => {
          const found = prev.some((session) => session.sessionId === updatedSession.sessionId);
          if (!found) return [updatedSession, ...prev];
          return prev.map((session) =>
            session.sessionId === updatedSession.sessionId ? updatedSession : session
          );
        });
        return updatedSession;
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
        }
        return null;
      }
    },
    [handleAuthExpired]
  );

  const clearCurrentSessionContext = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return true;
    try {
      return await clearSessionContext(sessionId);
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
      }
      return false;
    }
  }, [handleAuthExpired, sessionId]);

  const compactCurrentSessionContext = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      return await compactSessionContext(sessionId);
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
      }
      return false;
    }
  }, [handleAuthExpired, sessionId]);

  return {
    sessionId,
    setSessionId,
    sessionSummaries,
    isLoadingSessions,
    sessionLoadError,
    loadSessions,
    restoreStoredSession,
    resetSessionsForUserChange,
    ensureSession,
    createNewSession,
    switchSession,
    deleteSessionById,
    stopCurrentSession,
    stopSessionById,
    updateSessionById,
    clearCurrentSessionContext,
    compactCurrentSessionContext,
  };
}
