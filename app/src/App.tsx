import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import AuthGateway, { type AuthGatewayMode } from "@/components/AuthGateway";
import {
  fetchModels,
  getApiKey,
  getAuthMode,
  setApiKey,
  setUserSessionToken,
  clearApiKey,
  getUserId,
  setUserId,
  isUserSessionAuth,
  loginWithPassword,
  claimInvite,
  logoutUserSession,
  AuthError,
} from "@/lib/api";
import AutomationsPage from "@/components/workbench/AutomationsPage";
import ConnectorsPage from "@/components/workbench/ConnectorsPage";
import FilesPage from "@/components/workbench/FilesPage";
import InspectorPanel from "@/components/workbench/InspectorPanel";
import MobileSessionsPage from "@/components/workbench/MobileSessionsPage";
import MobileTabBar from "@/components/workbench/MobileTabBar";
import ProductTopBar from "@/components/workbench/ProductTopBar";
import SettingsPage from "@/components/workbench/SettingsPage";
import SessionPage from "@/components/workbench/SessionPage";
import WorkbenchShell from "@/components/workbench/WorkbenchShell";
import WorkspaceNav from "@/components/workbench/WorkspaceNav";
import {
  mobilePageTransition,
  mobilePageVariants,
  reducedMobilePageVariants,
  reducedMotionTransition,
} from "@/components/workbench/motionPrimitives";
import { type ChatRunSessionActions, useChatRun } from "@/hooks/useChatRun";
import { useSessionLifecycle } from "@/hooks/useSessionLifecycle";
import { clearStoredCurrentSessionId } from "@/lib/sessionPersistence";
import {
  initialLoginUserIdInput,
  loginUserIdValidationMessage,
  normalizeLoginUserId,
} from "@/lib/authLogin";
import {
  applyCurrentSessionRuntimeStatus,
  applySessionAttentionMarkers,
  createWorkbenchSessionsFromSessionSummaries,
  mergeInferredWorkbenchSessions,
  sessionStatusToWorkbenchStatus,
} from "@/lib/workbench";
import { shouldShowInspector, type WorkspaceView } from "@/lib/workspaceViews";
import type { SessionAttention, SessionDetail, WorkspaceFileOpenRequest } from "@/types";
import { sortModelOptions } from "@/lib/models";
import {
  getStoredDefaultModel,
  selectPreferredModel,
  setStoredDefaultModel,
} from "@/lib/modelPreference";
import { useI18n } from "@/i18n";

const WORKSPACE_ROOT_PATH = "/workspace";
const SESSION_RAIL_WIDTH_STORAGE_KEY = "ripple.workbench.sessionRailWidth";
const SESSION_RAIL_COLLAPSED_STORAGE_KEY = "ripple.workbench.sessionRailCollapsed";
const SESSION_RAIL_DEFAULT_WIDTH = 300;
const SESSION_RAIL_MIN_WIDTH = 220;
const SESSION_RAIL_MAX_WIDTH = 420;

function normalizeWorkspaceFolderPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === WORKSPACE_ROOT_PATH) return WORKSPACE_ROOT_PATH;
  if (trimmed.startsWith(`${WORKSPACE_ROOT_PATH}/`)) return trimmed;
  return WORKSPACE_ROOT_PATH;
}

function clampSessionRailWidth(value: number): number {
  return Math.min(SESSION_RAIL_MAX_WIDTH, Math.max(SESSION_RAIL_MIN_WIDTH, Math.round(value)));
}

function initialSessionRailWidth(): number {
  if (typeof window === "undefined") return SESSION_RAIL_DEFAULT_WIDTH;
  const rawValue = window.localStorage.getItem(SESSION_RAIL_WIDTH_STORAGE_KEY);
  if (rawValue === null) return SESSION_RAIL_DEFAULT_WIDTH;
  const stored = Number(rawValue);
  return Number.isFinite(stored) ? clampSessionRailWidth(stored) : SESSION_RAIL_DEFAULT_WIDTH;
}

function initialSessionRailCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SESSION_RAIL_COLLAPSED_STORAGE_KEY) === "true";
}

export default function Home() {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  // ── Auth state ──
  const [authState, setAuthState] = useState<"checking" | "needs_auth" | "authenticated">(() =>
    getApiKey() ? "authenticated" : "needs_auth"
  );
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [authMode, setAuthMode] = useState<AuthGatewayMode>(() =>
    getAuthMode() === "service" && getApiKey() ? "service" : "login"
  );
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [loginInput, setLoginInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [inviteDisplayNameInput, setInviteDisplayNameInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [authUserIdInput, setAuthUserIdInput] = useState(() =>
    initialLoginUserIdInput(getUserId())
  );
  const [authUserIdError, setAuthUserIdError] = useState<string | null>(null);

  // ── Model state ──
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState("codex-medium");
  const [defaultModel, setDefaultModel] = useState("codex-medium");
  const [openModelDropdown, setOpenModelDropdown] = useState<"composer" | null>(null);

  // ── User identity ──
  const [userId, setUserIdState] = useState<string>(() => getUserId());
  const productSessionActive = isUserSessionAuth();

  // ── UI state ──
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("ripple.workbench.inspectorCollapsed") === "true";
  });
  const [sessionRailWidth, setSessionRailWidth] = useState(initialSessionRailWidth);
  const sessionRailWidthRef = useRef(sessionRailWidth);
  const [isSessionRailCollapsed, setIsSessionRailCollapsed] = useState(initialSessionRailCollapsed);
  const [mobileSessionMode, setMobileSessionMode] = useState<"list" | "chat">("list");
  const [sessionScrollToBottomRequest, setSessionScrollToBottomRequest] = useState(0);
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [activeContextFolderPath, setActiveContextFolderPath] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("sessions");
  const [mobileMotionDirection, setMobileMotionDirection] = useState(0);
  const [mobileFilesReturnToChat, setMobileFilesReturnToChat] = useState(false);
  const [mobileSessionRestoreScrollTop, setMobileSessionRestoreScrollTop] = useState<number | null>(
    null
  );
  const [pendingWorkspaceFileOpen, setPendingWorkspaceFileOpen] =
    useState<WorkspaceFileOpenRequest | null>(null);
  const [sessionAttentionById, setSessionAttentionById] = useState<
    Record<string, SessionAttention | undefined>
  >({});
  const [acknowledgedSessionAttentionById, setAcknowledgedSessionAttentionById] = useState<
    Record<string, SessionAttention | undefined>
  >({});
  const selectedSessionIdRef = useRef<string | null>(null);
  const activeViewRef = useRef<WorkspaceView>("sessions");
  const workspaceFileOpenRequestIdRef = useRef(0);

  const sessionActionsRef = useRef<ChatRunSessionActions>({
    getSessionId: () => null,
    ensureSession: async () => null,
    loadSessions: async () => [],
    clearCurrentSessionContext: async () => true,
    compactCurrentSessionContext: async () => false,
    stopCurrentSession: async () => false,
    stopSession: async () => false,
  });

  const handleAuthExpired = useCallback((message: string) => {
    clearApiKey();
    setAuthState("needs_auth");
    setAuthMode("login");
    setAuthErrorMsg(message);
    setAuthUserIdInput(initialLoginUserIdInput(getUserId()));
    setAuthUserIdError(null);
    setActiveContextFolderPath(null);
    clearStoredCurrentSessionId();
  }, []);

  const handleWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshToken((prev) => prev + 1);
  }, []);

  const persistDefaultModel = useCallback(
    (model: string) => {
      setDefaultModel(model);
      setStoredDefaultModel(userId, model);
    },
    [userId]
  );

  const handleSelectModel = useCallback(
    (model: string) => {
      setSelectedModel(model);
      persistDefaultModel(model);
      setOpenModelDropdown(null);
    },
    [persistDefaultModel]
  );

  const handleAuthReset = useCallback(() => {
    if (isUserSessionAuth()) {
      void logoutUserSession().catch(() => undefined);
    }
    clearApiKey();
    clearStoredCurrentSessionId();
    setAuthMode("login");
    setAuthUserIdInput(initialLoginUserIdInput(getUserId()));
    setAuthUserIdError(null);
    setActiveContextFolderPath(null);
    setAuthState("needs_auth");
  }, []);

  const getSessionActions = useCallback(() => sessionActionsRef.current, []);

  const handleSessionAttention = useCallback(
    (targetSessionId: string, attention: SessionAttention | null) => {
      setAcknowledgedSessionAttentionById((prev) => {
        if (!prev[targetSessionId]) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });
      setSessionAttentionById((prev) => {
        const sessionIsOpen =
          selectedSessionIdRef.current === targetSessionId && activeViewRef.current === "sessions";
        const shouldClear =
          !attention || ((attention === "completed" || attention === "error") && sessionIsOpen);

        if (shouldClear) {
          if (!prev[targetSessionId]) return prev;
          const next = { ...prev };
          delete next[targetSessionId];
          return next;
        }

        if (prev[targetSessionId] === attention) return prev;
        return { ...prev, [targetSessionId]: attention };
      });
    },
    []
  );

  const {
    input,
    setInput,
    messages,
    pendingFiles,
    pendingLocalImages,
    isUploadingFiles,
    attachmentUploadError,
    isGenerating,
    runningSessionIds,
    inputFocusToken,
    tokenUsage,
    lastContextTokens,
    planSteps,
    planProgress,
    currentSessionRuntimeStatus,
    timelineEvents,
    feishuAuthWaiting,
    resetSessionView,
    abortRunAndResetSessionView,
    applySessionDetails,
    handleStop,
    handleClearContext,
    handleCompactContext,
    handleAttachFiles,
    handleRemovePendingFile,
    handleAddPendingImages,
    handleRemovePendingLocalImage,
    handleSendMessage,
    handleQuickReply,
    handlePermissionResolve,
    handleFeishuAuthOpen,
  } = useChatRun({
    selectedModel,
    onSelectedModelChange: setSelectedModel,
    onAuthExpired: handleAuthExpired,
    onWorkspaceRefresh: handleWorkspaceRefresh,
    getSessionActions,
    onSessionAttention: handleSessionAttention,
  });

  const handleApplySessionDetails = useCallback(
    (details: SessionDetail) => {
      applySessionDetails(details);
      setActiveContextFolderPath(details.contextFolderPath ?? null);
    },
    [applySessionDetails]
  );

  const handleSessionActivated = useCallback(() => {
    setActiveView("sessions");
  }, []);

  const {
    sessionId,
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
  } = useSessionLifecycle({
    authState,
    isGenerating,
    onAuthExpired: handleAuthExpired,
    onApplySessionDetails: handleApplySessionDetails,
    onNewSessionView: resetSessionView,
    onDeleteCurrentSession: resetSessionView,
    onSessionActivated: handleSessionActivated,
  });

  const handleSelectDefaultModel = useCallback(
    (model: string) => {
      persistDefaultModel(model);
      if (!sessionId) {
        setSelectedModel(model);
      }
    },
    [persistDefaultModel, sessionId]
  );

  useEffect(() => {
    window.localStorage.setItem(
      "ripple.workbench.inspectorCollapsed",
      String(isInspectorCollapsed)
    );
  }, [isInspectorCollapsed]);

  useEffect(() => {
    sessionRailWidthRef.current = sessionRailWidth;
    window.localStorage.setItem(SESSION_RAIL_WIDTH_STORAGE_KEY, String(sessionRailWidth));
  }, [sessionRailWidth]);

  useEffect(() => {
    window.localStorage.setItem(SESSION_RAIL_COLLAPSED_STORAGE_KEY, String(isSessionRailCollapsed));
  }, [isSessionRailCollapsed]);

  useEffect(() => {
    selectedSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    sessionActionsRef.current = {
      getSessionId: () => sessionId,
      ensureSession: (model) => ensureSession(model, activeContextFolderPath),
      loadSessions,
      clearCurrentSessionContext,
      compactCurrentSessionContext,
      stopCurrentSession,
      stopSession: stopSessionById,
    };
  }, [
    activeContextFolderPath,
    clearCurrentSessionContext,
    compactCurrentSessionContext,
    ensureSession,
    loadSessions,
    sessionId,
    stopCurrentSession,
    stopSessionById,
  ]);

  const handleUserIdChange = useCallback(
    async (newUid: string) => {
      if (isUserSessionAuth()) {
        return;
      }
      try {
        setUserId(newUid);
      } catch {
        return;
      }
      setUserIdState(newUid);
      const preferredModel = selectPreferredModel(models, getStoredDefaultModel(newUid));
      setDefaultModel(preferredModel);
      setSelectedModel(preferredModel);
      setSessionAttentionById({});
      setAcknowledgedSessionAttentionById({});
      setActiveContextFolderPath(null);
      abortRunAndResetSessionView();
      resetSessionsForUserChange();
      if (authState === "authenticated") {
        const loaded = await loadSessions();
        console.info(`[ripple] switched to user "${newUid}", loaded ${loaded.length} sessions`);
        if (loaded.length > 0) {
          await restoreStoredSession(loaded);
        }
      }
    },
    [
      authState,
      abortRunAndResetSessionView,
      loadSessions,
      models,
      resetSessionsForUserChange,
      restoreStoredSession,
    ]
  );

  useEffect(() => {
    const handleOpenWorkspaceFile = (event: Event) => {
      const customEvent = event as CustomEvent<{
        path: string;
        lineNumber?: number;
        userId?: string;
        routedFromApp?: boolean;
      }>;
      const { path, lineNumber, userId: targetUserId } = customEvent.detail;
      if (!path) return;
      const linkUserId = productSessionActive ? undefined : targetUserId;

      workspaceFileOpenRequestIdRef.current += 1;
      setPendingWorkspaceFileOpen({
        id: workspaceFileOpenRequestIdRef.current,
        path,
        lineNumber,
        userId: linkUserId,
      });

      const canUseInspector = activeViewRef.current === "sessions" && window.innerWidth >= 1280;
      if (canUseInspector) {
        setIsInspectorCollapsed(false);
      } else {
        const scrollContainer = document.querySelector<HTMLDivElement>(
          '[data-ripple-session-scroll="timeline"]'
        );
        const shouldReturnToSession = activeViewRef.current === "sessions";
        setMobileSessionRestoreScrollTop(
          shouldReturnToSession ? (scrollContainer?.scrollTop ?? 0) : null
        );
        setMobileFilesReturnToChat(shouldReturnToSession);
        if (activeViewRef.current !== "files") setActiveView("files");
        setMobileSessionMode("list");
      }

      if (linkUserId && linkUserId !== userId) {
        void handleUserIdChange(linkUserId);
      }
    };
    window.addEventListener("open-workspace-file", handleOpenWorkspaceFile);
    return () => {
      window.removeEventListener("open-workspace-file", handleOpenWorkspaceFile);
    };
  }, [productSessionActive, userId, handleUserIdChange]);

  const handlePendingWorkspaceFileOpenConsumed = useCallback((requestId: number) => {
    setPendingWorkspaceFileOpen((current) => (current?.id === requestId ? null : current));
  }, []);

  // ── Init on auth ──
  useEffect(() => {
    if (authState !== "authenticated") return;
    (async () => {
      try {
        const fetched = sortModelOptions(await fetchModels());
        setModels(fetched);
        if (fetched.length > 0) {
          const currentUserId = getUserId();
          const preferredModel = selectPreferredModel(
            fetched,
            getStoredDefaultModel(currentUserId)
          );
          setDefaultModel(preferredModel);
          setSelectedModel(preferredModel);
        }
        const loadedSessions = await loadSessions();
        if (loadedSessions.length > 0) {
          await restoreStoredSession(loadedSessions);
        }
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired(t("auth.sessionExpired"));
        }
      }
    })();
  }, [authState, handleAuthExpired, loadSessions, restoreStoredSession, t]);

  // ── Auth submit ──
  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    const userIdError = loginUserIdValidationMessage(authUserIdInput);
    if (userIdError) {
      setAuthUserIdError(userIdError);
      return;
    }
    const nextUserId = normalizeLoginUserId(authUserIdInput);
    try {
      setUserId(nextUserId);
    } catch {
      setAuthUserIdError(t("auth.userIdInvalid"));
      return;
    }
    if (nextUserId !== userId) {
      setUserIdState(nextUserId);
      setSessionAttentionById({});
      setAcknowledgedSessionAttentionById({});
      setActiveContextFolderPath(null);
      abortRunAndResetSessionView();
      resetSessionsForUserChange();
      clearStoredCurrentSessionId();
    }
    setApiKey(keyInput.trim());
    setKeyInput("");
    setAuthErrorMsg("");
    setAuthUserIdError(null);
    setAuthState("authenticated");
  };

  const activateUserSession = useCallback(
    (token: string, nextUserId: string) => {
      setUserSessionToken(token, nextUserId);
      setUserIdState(nextUserId);
      setSessionAttentionById({});
      setAcknowledgedSessionAttentionById({});
      setActiveContextFolderPath(null);
      abortRunAndResetSessionView();
      resetSessionsForUserChange();
      clearStoredCurrentSessionId();
      setAuthErrorMsg("");
      setAuthUserIdError(null);
      setAuthState("authenticated");
    },
    [abortRunAndResetSessionView, resetSessionsForUserChange]
  );

  const handlePasswordLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!loginInput.trim() || !passwordInput) return;
    setIsAuthSubmitting(true);
    setAuthErrorMsg("");
    try {
      const auth = await loginWithPassword(loginInput.trim(), passwordInput);
      activateUserSession(auth.token, auth.user_id);
      setPasswordInput("");
    } catch (error) {
      setAuthErrorMsg(error instanceof Error ? error.message : t("auth.loginFailed"));
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleInviteClaim = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inviteCodeInput.trim() || !loginInput.trim() || !passwordInput) return;
    setIsAuthSubmitting(true);
    setAuthErrorMsg("");
    try {
      const auth = await claimInvite({
        invite_code: inviteCodeInput.trim(),
        login: loginInput.trim(),
        password: passwordInput,
        display_name: inviteDisplayNameInput.trim() || null,
      });
      activateUserSession(auth.token, auth.user_id);
      setInviteCodeInput("");
      setInviteDisplayNameInput("");
      setPasswordInput("");
    } catch (error) {
      setAuthErrorMsg(error instanceof Error ? error.message : t("auth.inviteClaimFailed"));
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const acknowledgeSessionAttention = useCallback(
    (targetSessionId: string) => {
      const storedAttention = sessionAttentionById[targetSessionId];
      const summary = sessionSummaries.find((summary) => summary.sessionId === targetSessionId);
      const shouldAcknowledgeError =
        storedAttention === "error" ||
        (summary ? sessionStatusToWorkbenchStatus(summary.status) === "failed" : false);

      setSessionAttentionById((prev) => {
        if (!prev[targetSessionId]) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });

      if (shouldAcknowledgeError) {
        setAcknowledgedSessionAttentionById((prev) =>
          prev[targetSessionId] === "error" ? prev : { ...prev, [targetSessionId]: "error" }
        );
      }
    },
    [sessionAttentionById, sessionSummaries]
  );

  // ── Session switch ──
  const handleSwitchSession = useCallback(
    async (targetSessionId: string) => {
      const switched = await switchSession(targetSessionId);
      if (switched) {
        acknowledgeSessionAttention(targetSessionId);
        setSessionScrollToBottomRequest((request) => request + 1);
      }
    },
    [acknowledgeSessionAttention, switchSession]
  );

  // ── New session ──
  const handleNewSession = async () => {
    const session = await createNewSession(defaultModel, activeContextFolderPath);
    if (session) {
      setSelectedModel(session.model || defaultModel);
      setActiveContextFolderPath(session.contextFolderPath ?? activeContextFolderPath);
    }
    setActiveView("sessions");
    setMobileMotionDirection(1);
    setMobileSessionMode("chat");
  };

  // ── Delete session ──
  const handleDeleteSession = async (targetSessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const deleted = await deleteSessionById(targetSessionId);
    if (deleted) {
      setSessionAttentionById((prev) => {
        if (!prev[targetSessionId]) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });
      setAcknowledgedSessionAttentionById((prev) => {
        if (!prev[targetSessionId]) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });
    }
  };

  const handleSelectView = useCallback(
    (view: WorkspaceView) => {
      setMobileFilesReturnToChat(false);
      setMobileSessionRestoreScrollTop(null);
      if (view !== "files") setPendingWorkspaceFileOpen(null);
      setMobileMotionDirection(0);
      setActiveView(view);
      if (view === "sessions") {
        setMobileSessionMode("list");
      }
      if (view === "sessions" && sessionId) {
        acknowledgeSessionAttention(sessionId);
      }
    },
    [acknowledgeSessionAttention, sessionId]
  );
  const handleReturnFromMobileFiles = useCallback(() => {
    setMobileFilesReturnToChat(false);
    setPendingWorkspaceFileOpen(null);
    setActiveView("sessions");
    setMobileMotionDirection(1);
    setMobileSessionMode("chat");
  }, []);
  const handleOpenMobileSessionList = useCallback(() => {
    setMobileFilesReturnToChat(false);
    setPendingWorkspaceFileOpen(null);
    setMobileSessionRestoreScrollTop(null);
    setActiveView("sessions");
    setMobileMotionDirection(-1);
    setMobileSessionMode("list");
    if (sessionId) acknowledgeSessionAttention(sessionId);
  }, [acknowledgeSessionAttention, sessionId]);
  const handleSelectMobileSession = useCallback(
    async (targetSessionId: string) => {
      await handleSwitchSession(targetSessionId);
      setMobileMotionDirection(1);
      setMobileSessionMode("chat");
    },
    [handleSwitchSession]
  );
  const selectedSessionIsGenerating = Boolean(sessionId && runningSessionIds.includes(sessionId));
  const selectedSessionRuntimeStatus =
    currentSessionRuntimeStatus && sessionId ? currentSessionRuntimeStatus : null;
  const baseWorkbenchSessions = useMemo(() => {
    const base = createWorkbenchSessionsFromSessionSummaries(sessionSummaries);
    const runtimeActivityAt = new Date().toISOString();
    return runningSessionIds.reduce(
      (sessions, activeSessionId) =>
        applyCurrentSessionRuntimeStatus(sessions, activeSessionId, "running", runtimeActivityAt),
      currentSessionRuntimeStatus && sessionId
        ? applyCurrentSessionRuntimeStatus(
            base,
            sessionId,
            currentSessionRuntimeStatus,
            runtimeActivityAt
          )
        : base
    );
  }, [currentSessionRuntimeStatus, runningSessionIds, sessionId, sessionSummaries]);
  const selectedExistingSession = sessionId
    ? baseWorkbenchSessions.find((session) => session.sessionId === sessionId) || null
    : null;
  const currentSessionShouldAppearInList =
    messages.length > 0 ||
    planSteps.length > 0 ||
    Boolean(planProgress) ||
    Boolean(selectedSessionRuntimeStatus);
  const inferredCurrentSession = useMemo(
    () =>
      sessionId && !selectedExistingSession && currentSessionShouldAppearInList
        ? {
            sessionId,
            title: "Current session",
            pinned: false,
            projectId: null,
            projectName: null,
            projectRoot: null,
            contextFolderPath: activeContextFolderPath,
            status: selectedSessionRuntimeStatus || ("idle" as const),
            model: selectedModel,
            lastActivityAt: new Date().toISOString(),
            messageCount: messages.length,
            changedFileCount: 0,
            pendingApprovalCount: 0,
          }
        : null,
    [
      activeContextFolderPath,
      currentSessionShouldAppearInList,
      messages.length,
      selectedExistingSession,
      selectedModel,
      selectedSessionRuntimeStatus,
      sessionId,
    ]
  );
  const inferredRunningSessions = useMemo(
    () =>
      runningSessionIds
        .filter(
          (activeSessionId) =>
            activeSessionId !== sessionId &&
            !baseWorkbenchSessions.some((session) => session.sessionId === activeSessionId)
        )
        .map((activeSessionId) => ({
          sessionId: activeSessionId,
          title: "Running session",
          pinned: false,
          status: "running" as const,
          model: selectedModel,
          lastActivityAt: new Date().toISOString(),
          messageCount: 0,
          changedFileCount: 0,
          pendingApprovalCount: 0,
        })),
    [baseWorkbenchSessions, runningSessionIds, selectedModel, sessionId]
  );
  const mergedWorkbenchSessions = useMemo(
    () =>
      mergeInferredWorkbenchSessions(baseWorkbenchSessions, [
        inferredCurrentSession,
        ...inferredRunningSessions,
      ]),
    [baseWorkbenchSessions, inferredCurrentSession, inferredRunningSessions]
  );
  const displayWorkbenchSessions = useMemo(
    () =>
      applySessionAttentionMarkers(
        mergedWorkbenchSessions,
        sessionAttentionById,
        activeView === "sessions" ? sessionId : null,
        acknowledgedSessionAttentionById
      ),
    [
      activeView,
      acknowledgedSessionAttentionById,
      mergedWorkbenchSessions,
      sessionAttentionById,
      sessionId,
    ]
  );
  const selectedWorkbenchSession = sessionId
    ? displayWorkbenchSessions.find((session) => session.sessionId === sessionId) || null
    : null;
  const isComposerBlocked = selectedWorkbenchSession?.status === "compacting";

  const handleSelectChatFolder = useCallback(
    async (path: string) => {
      const normalizedPath = normalizeWorkspaceFolderPath(path);
      const nextContextFolderPath = normalizedPath === WORKSPACE_ROOT_PATH ? null : normalizedPath;
      const currentContextFolderPath =
        selectedWorkbenchSession?.contextFolderPath ?? activeContextFolderPath;
      if ((currentContextFolderPath ?? null) === nextContextFolderPath) {
        return;
      }

      if (!sessionId) {
        setActiveContextFolderPath(nextContextFolderPath);
        return;
      }

      const updated = await updateSessionById(sessionId, {
        contextFolderPath: nextContextFolderPath,
      });
      if (updated) {
        setActiveContextFolderPath(updated.contextFolderPath ?? null);
        setActiveView("sessions");
        setMobileMotionDirection(1);
        setMobileSessionMode("chat");
      }
    },
    [activeContextFolderPath, selectedWorkbenchSession, sessionId, updateSessionById]
  );

  const updateSessionRailWidth = useCallback((value: number) => {
    setSessionRailWidth(clampSessionRailWidth(value));
  }, []);

  const handleSessionRailResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sessionRailWidthRef.current;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateSessionRailWidth(startWidth + moveEvent.clientX - startX);
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [updateSessionRailWidth]
  );

  const handleSessionRailResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        updateSessionRailWidth(sessionRailWidthRef.current - (event.shiftKey ? 40 : 16));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        updateSessionRailWidth(sessionRailWidthRef.current + (event.shiftKey ? 40 : 16));
      }
    },
    [updateSessionRailWidth]
  );

  const mainContent =
    activeView === "home" ? (
      <SettingsPage
        userId={userId}
        apiKey={getApiKey()}
        authMode={getAuthMode()}
        models={models}
        defaultModel={defaultModel}
        selectedModel={selectedModel}
        onSelectDefaultModel={handleSelectDefaultModel}
        onApiKeyChange={handleAuthReset}
      />
    ) : activeView === "files" ? (
      <FilesPage
        userId={userId}
        refreshToken={workspaceRefreshToken}
        onBack={mobileFilesReturnToChat ? handleReturnFromMobileFiles : undefined}
        openFileRequest={pendingWorkspaceFileOpen}
        onOpenFileRequestConsumed={handlePendingWorkspaceFileOpenConsumed}
      />
    ) : activeView === "automations" ? (
      <AutomationsPage
        selectedModel={defaultModel}
        models={models}
        onAuthExpired={handleAuthExpired}
      />
    ) : activeView === "connectors" ? (
      <ConnectorsPage userId={userId} onConnectorStateChange={loadSessions} />
    ) : (
      <div className="h-full min-h-0">
        <div className={mobileSessionMode === "list" ? "h-full lg:hidden" : "hidden"}>
          <MobileSessionsPage
            sessions={displayWorkbenchSessions}
            isLoading={isLoadingSessions}
            sessionLoadError={sessionLoadError}
            selectedSessionId={sessionId}
            onNewSession={handleNewSession}
            onSelectSession={(selectedSessionId) =>
              void handleSelectMobileSession(selectedSessionId)
            }
            onDeleteSession={handleDeleteSession}
            onUpdateSession={updateSessionById}
          />
        </div>
        <div
          data-ripple-session-layout="desktop"
          className={
            mobileSessionMode === "chat"
              ? "relative flex h-full min-h-0 lg:flex"
              : "relative hidden h-full min-h-0 lg:flex"
          }
        >
          {!isSessionRailCollapsed ? (
            <div
              className="relative hidden h-full min-h-0 shrink-0 lg:block"
              style={{ width: sessionRailWidth }}
            >
              <WorkspaceNav
                sessions={displayWorkbenchSessions}
                selectedSessionId={sessionId}
                isLoading={isLoadingSessions}
                sessionLoadError={sessionLoadError}
                onNewSession={handleNewSession}
                onSelectSession={(selectedSessionId) => {
                  void handleSwitchSession(selectedSessionId);
                  setMobileSessionMode("chat");
                }}
                onDeleteSession={handleDeleteSession}
                onUpdateSession={updateSessionById}
                onCollapse={() => setIsSessionRailCollapsed(true)}
              />
              <div
                role="separator"
                aria-label={t("common.resizeSessionList")}
                aria-orientation="vertical"
                aria-valuemin={SESSION_RAIL_MIN_WIDTH}
                aria-valuemax={SESSION_RAIL_MAX_WIDTH}
                aria-valuenow={sessionRailWidth}
                tabIndex={0}
                onPointerDown={handleSessionRailResizeStart}
                onKeyDown={handleSessionRailResizeKeyDown}
                className="group absolute top-0 right-0 bottom-0 z-20 flex w-2 translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#eaf4ff] focus:bg-[#eaf4ff]"
              >
                <span className="h-12 w-0.5 rounded-full bg-[#007aff] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-ripple-panel-edge-handle="session-list"
              onClick={() => setIsSessionRailCollapsed(false)}
              aria-label={t("common.expandSessionList")}
              title={t("common.expandSessionList")}
              className="absolute top-1/2 left-0 z-30 hidden h-14 w-7 -translate-y-1/2 items-center justify-center rounded-r-2xl border border-l-0 border-[#cfe4ff] bg-white/82 text-[#007aff] shadow-[0_8px_18px_rgba(60,60,67,0.10)] backdrop-blur-xl transition-colors hover:border-[#8ec8ff] hover:bg-[#eaf4ff] focus-visible:ring-2 focus-visible:ring-[#cfe4ff] focus-visible:outline-none lg:inline-flex"
            >
              <ChevronRight size={16} />
            </button>
          )}
          <div className="h-full min-w-0 flex-1">
            <SessionPage
              userId={userId}
              session={selectedWorkbenchSession}
              messages={messages}
              timelineEvents={timelineEvents}
              planProgress={planProgress}
              planSteps={planSteps}
              tokenUsage={tokenUsage}
              lastContextTokens={lastContextTokens}
              input={input}
              pendingFiles={pendingFiles}
              pendingLocalImages={pendingLocalImages}
              isUploadingFiles={isUploadingFiles}
              uploadError={attachmentUploadError}
              isGenerating={selectedSessionIsGenerating}
              isComposerBlocked={isComposerBlocked}
              focusToken={inputFocusToken}
              selectedModel={selectedModel}
              models={models}
              isModelDropdownOpen={openModelDropdown === "composer"}
              sessionId={sessionId}
              scrollToBottomRequest={sessionScrollToBottomRequest}
              contextFolderPath={activeContextFolderPath}
              onSelectWorkspaceFolder={handleSelectChatFolder}
              onNewSession={handleNewSession}
              onInputChange={setInput}
              onClearContext={handleClearContext}
              onCompactContext={handleCompactContext}
              onAttachFiles={handleAttachFiles}
              onRemovePendingFile={handleRemovePendingFile}
              onAddPendingImages={handleAddPendingImages}
              onRemovePendingLocalImage={handleRemovePendingLocalImage}
              onToggleModelDropdown={() =>
                setOpenModelDropdown((open) => (open === "composer" ? null : "composer"))
              }
              onSelectModel={handleSelectModel}
              onSend={handleSendMessage}
              onStop={handleStop}
              onQuickReply={handleQuickReply}
              onPermissionResolve={handlePermissionResolve}
              onFeishuAuthOpen={handleFeishuAuthOpen}
              feishuAuthWaiting={feishuAuthWaiting}
              onBackToMobileSessions={handleOpenMobileSessionList}
              isInspectorCollapsed={isInspectorCollapsed}
              restoreScrollTop={mobileSessionRestoreScrollTop}
              onRestoreScrollComplete={() => setMobileSessionRestoreScrollTop(null)}
            />
          </div>
        </div>
      </div>
    );
  const mobileNav =
    activeView === "sessions" && mobileSessionMode === "chat" ? null : (
      <MobileTabBar activeView={activeView} onSelectView={handleSelectView} />
    );
  const mobileMotionStage =
    activeView === "sessions" ? `${activeView}:${mobileSessionMode}` : `${activeView}:page`;
  const animatedMainContent = (
    <AnimatePresence mode="wait" initial={false} custom={mobileMotionDirection}>
      <motion.div
        key={mobileMotionStage}
        data-ripple-mobile-motion-stage={mobileMotionStage}
        custom={mobileMotionDirection}
        variants={reduceMotion ? reducedMobilePageVariants : mobilePageVariants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={reduceMotion ? reducedMotionTransition : mobilePageTransition}
        className="h-full min-h-0"
      >
        {mainContent}
      </motion.div>
    </AnimatePresence>
  );

  // ═══════════════════════════════════════════════════════
  // AUTH SCREEN
  // ═══════════════════════════════════════════════════════
  if (authState !== "authenticated") {
    return (
      <AuthGateway
        authMode={authMode}
        authErrorMsg={authErrorMsg}
        isAuthSubmitting={isAuthSubmitting}
        loginInput={loginInput}
        passwordInput={passwordInput}
        inviteCodeInput={inviteCodeInput}
        inviteDisplayNameInput={inviteDisplayNameInput}
        keyInput={keyInput}
        authUserIdInput={authUserIdInput}
        authUserIdError={authUserIdError}
        onModeChange={(mode) => {
          setAuthMode(mode);
          setAuthErrorMsg("");
          setAuthUserIdError(null);
        }}
        onAuthErrorClear={() => setAuthErrorMsg("")}
        onAuthUserIdErrorClear={() => setAuthUserIdError(null)}
        onLoginInputChange={setLoginInput}
        onPasswordInputChange={setPasswordInput}
        onInviteCodeInputChange={setInviteCodeInput}
        onInviteDisplayNameInputChange={setInviteDisplayNameInput}
        onKeyInputChange={setKeyInput}
        onAuthUserIdInputChange={setAuthUserIdInput}
        onPasswordLogin={handlePasswordLogin}
        onInviteClaim={handleInviteClaim}
        onServiceAuth={handleAuthSubmit}
      />
    );
  }

  // ═══════════════════════════════════════════════════════
  // MAIN APP
  // ═══════════════════════════════════════════════════════
  return (
    <>
      <WorkbenchShell
        isInspectorCollapsed={isInspectorCollapsed}
        onExpandInspector={() => setIsInspectorCollapsed(false)}
        topBar={
          <ProductTopBar
            activeView={activeView}
            userId={userId}
            onSelectView={handleSelectView}
            onOpenSettings={() => handleSelectView("home")}
          />
        }
        content={animatedMainContent}
        inspector={
          shouldShowInspector(activeView) ? (
            <InspectorPanel
              userId={userId}
              refreshToken={workspaceRefreshToken}
              onCollapse={() => setIsInspectorCollapsed(true)}
              openFileRequest={pendingWorkspaceFileOpen}
              onOpenFileRequestConsumed={handlePendingWorkspaceFileOpenConsumed}
            />
          ) : null
        }
        mobileNav={mobileNav}
      />
    </>
  );
}
