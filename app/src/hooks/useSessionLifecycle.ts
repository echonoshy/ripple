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
  forkSession,
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
import { useI18n } from "@/i18n";

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

interface CreateNewSessionOptions {
  refresh?: boolean;
}

interface LoadSessionsOptions {
  showLoading?: boolean;
}

function mergeCreatedSessionSummary(
  sessions: SessionSummary[],
  createdSession: SessionSummary
): SessionSummary[] {
  return [
    createdSession,
    ...sessions.filter((session) => session.sessionId !== createdSession.sessionId),
  ];
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
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionSummaries, setSessionSummaries] = useState<SessionSummary[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);

  const handleAuthExpired = useCallback(
    (message?: string) => {
      clearStoredCurrentSessionId();
      onAuthExpired(message ?? t("auth.apiKeyExpired"));
    },
    [onAuthExpired, t]
  );

  const loadSessions = useCallback(
    async (options: LoadSessionsOptions = {}): Promise<SessionSummary[]> => {
      if (authState !== "authenticated") return [];
      const showLoading = options.showLoading !== false;
      try {
        if (showLoading) {
          setIsLoadingSessions(true);
          setSessionLoadError(null);
        }
        const loadedSessions = await fetchSessions();
        setSessionSummaries(loadedSessions);
        return loadedSessions;
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
          return [];
        }
        if (showLoading) {
          setSessionLoadError(readableApiErrorMessage(err));
        }
        return [];
      } finally {
        if (showLoading) {
          setIsLoadingSessions(false);
        }
      }
    },
    [authState, handleAuthExpired]
  );

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

  const ensureSession = useCallback(
    async (model?: string | null, contextFolderPath?: string | null): Promise<string | null> => {
      if (sessionId) return sessionId;
      try {
        const session = await createSession({ model, contextFolderPath });
        setSessionId(session.sessionId);
        setStoredCurrentSessionId(undefined, session.sessionId);
        return session.sessionId;
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
        }
        return null;
      }
    },
    [handleAuthExpired, sessionId]
  );

  const createNewSession = useCallback(
    async (
      model?: string | null,
      contextFolderPath?: string | null,
      options: CreateNewSessionOptions = {}
    ): Promise<SessionSummary | null> => {
      try {
        const session = await createSession({ model, contextFolderPath });
        setSessionId(session.sessionId);
        setSessionSummaries((prev) => mergeCreatedSessionSummary(prev, session));
        setStoredCurrentSessionId(undefined, session.sessionId);
        onNewSessionView();
        onSessionActivated();
        if (options.refresh !== false) {
          await loadSessions();
        } else {
          void loadSessions({ showLoading: false });
        }
        return session;
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
        }
        return null;
      }
    },
    [handleAuthExpired, loadSessions, onNewSessionView, onSessionActivated]
  );

  const switchSession = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      if (targetSessionId === sessionId && isGenerating) {
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
    [applySessionDetails, isGenerating, onSessionActivated, sessionId]
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

  const forkSessionById = useCallback(
    async (targetSessionId: string): Promise<SessionSummary | null> => {
      try {
        const forkedSession = await forkSession(targetSessionId);
        setSessionSummaries((prev) => mergeCreatedSessionSummary(prev, forkedSession));
        const details = await fetchSessionDetails(forkedSession.sessionId);
        if (details) {
          applySessionDetails(details);
        } else {
          setSessionId(forkedSession.sessionId);
          setStoredCurrentSessionId(undefined, forkedSession.sessionId);
        }
        onSessionActivated();
        void loadSessions({ showLoading: false });
        return forkedSession;
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
        }
        return null;
      }
    },
    [applySessionDetails, handleAuthExpired, loadSessions, onSessionActivated]
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
    forkSessionById,
    stopCurrentSession,
    stopSessionById,
    updateSessionById,
    clearCurrentSessionContext,
    compactCurrentSessionContext,
  };
}
