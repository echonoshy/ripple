import React, { Suspense, lazy, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import { ChevronRight, Loader2 } from "lucide-react";
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
import MobileSessionStack from "@/components/workbench/MobileSessionStack";
import MobileSessionsPage from "@/components/workbench/MobileSessionsPage";
import MobileTabBar from "@/components/workbench/MobileTabBar";
import ProductTopBar from "@/components/workbench/ProductTopBar";
import SessionPage from "@/components/workbench/SessionPage";
import WorkbenchShell from "@/components/workbench/WorkbenchShell";
import WorkspaceNav from "@/components/workbench/WorkspaceNav";
import {
  mobilePageSwitchTransition,
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
  sessionAttentionFromStatus,
  sessionStatusToWorkbenchStatus,
  shouldNotifySessionAttention,
  stabilizeWorkbenchSessionOrder,
} from "@/lib/workbench";
import { shouldShowInspector, type WorkspaceView } from "@/lib/workspaceViews";
import type {
  SessionAttention,
  SessionControlAction,
  SessionDetail,
  UsageInfo,
  WorkbenchSessionSummary,
  WorkspaceFileOpenRequest,
} from "@/types";
import { sortModelOptions } from "@/lib/models";
import {
  getStoredDefaultModel,
  selectPreferredModel,
  setStoredDefaultModel,
} from "@/lib/modelPreference";
import { getClientStorageItem, setClientStorageItem } from "@/lib/platform";
import { useI18n } from "@/i18n";
import { WORKBENCH_ICON_BUTTON_CLASS } from "@/components/workbench/stylePrimitives";
import {
  SESSION_RAIL_MAX_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
  WORKSPACE_ROOT_PATH,
  normalizeWorkspaceFolderPath,
  useAndroidChatBackGesture,
  useMobileLayout,
  useSessionRail,
} from "@/hooks/workbenchLayout";

const TasksPage = lazy(() => import("@/components/workbench/TasksPage"));
const FilesPage = lazy(() => import("@/components/workbench/FilesPage"));
const InspectorPanel = lazy(() => import("@/components/workbench/InspectorPanel"));
const SettingsPage = lazy(() => import("@/components/workbench/SettingsPage"));
const SkillsPage = lazy(() => import("@/components/workbench/SkillsPage"));
const emptyUsage: UsageInfo = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

function LazyWorkbenchFallback() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex h-full min-h-0 items-center justify-center bg-[#F8FAFC] text-[#1456F0]"
    >
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
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
    return getClientStorageItem("ripple.workbench.inspectorCollapsed") === "true";
  });
  const {
    sessionRailWidth,
    isSessionRailCollapsed,
    setIsSessionRailCollapsed,
    handleSessionRailResizeStart,
    handleSessionRailResizeKeyDown,
  } = useSessionRail();
  const [mobileSessionMode, setMobileSessionMode] = useState<"list" | "chat">("list");
  const isMobileLayout = useMobileLayout();
  const [sessionScrollToBottomRequest, setSessionScrollToBottomRequest] = useState(0);
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [activeContextFolderPath, setActiveContextFolderPath] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("sessions");
  const [mobileMotionDirection, setMobileMotionDirection] = useState(0);
  const [mobileFilesReturnToChat, setMobileFilesReturnToChat] = useState(false);
  const [isSkillsMobileBackGestureActive, setIsSkillsMobileBackGestureActive] = useState(false);
  const [skillsResetToRootRequest, setSkillsResetToRootRequest] = useState(0);
  const [mobileSessionRestoreScrollTop, setMobileSessionRestoreScrollTop] = useState<number | null>(
    null
  );
  const [pendingMobileSession, setPendingMobileSession] = useState<WorkbenchSessionSummary | null>(
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

  useAndroidChatBackGesture({
    authState,
    activeView,
    mobileSessionMode,
    isSkillsMobileBackGestureActive,
  });

  const selectedSessionIdRef = useRef<string | null>(null);
  const selectedModelOverrideBySessionRef = useRef<Record<string, string>>({});
  const activeViewRef = useRef<WorkspaceView>("sessions");
  const isMobileLayoutRef = useRef(isMobileLayout);
  const mobileSessionModeRef = useRef<"list" | "chat">(mobileSessionMode);
  const workspaceFileOpenRequestIdRef = useRef(0);
  const mobileSessionSelectionRequestRef = useRef(0);
  const displayWorkbenchSessionOrderRef = useRef<WorkbenchSessionSummary[]>([]);

  const sessionActionsRef = useRef<ChatRunSessionActions>({
    getSessionId: () => null,
    ensureSession: async () => null,
    createSession: async () => null,
    loadSessions: async () => [],
    clearCurrentSessionContext: async () => true,
    compactCurrentSessionContext: async () => false,
    stopCurrentSession: async () => false,
    stopSession: async () => false,
  });

  const handleAuthExpired = useCallback((message: string) => {
    selectedModelOverrideBySessionRef.current = {};
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

  const rememberSelectedModelOverride = useCallback((model: string) => {
    const activeSessionId = selectedSessionIdRef.current;
    if (!activeSessionId) return;
    selectedModelOverrideBySessionRef.current = {
      ...selectedModelOverrideBySessionRef.current,
      [activeSessionId]: model,
    };
  }, []);

  const handleSessionDetailModelChange = useCallback(
    (model: string, detailSessionId?: string | null) => {
      const targetSessionId = detailSessionId || selectedSessionIdRef.current;
      if (!targetSessionId) {
        setSelectedModel(model);
        return;
      }
      setSelectedModel(selectedModelOverrideBySessionRef.current[targetSessionId] || model);
    },
    []
  );

  const handleAuthReset = useCallback(() => {
    selectedModelOverrideBySessionRef.current = {};
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
      const visibleSessionDetailId =
        activeViewRef.current === "sessions" &&
        (!isMobileLayoutRef.current || mobileSessionModeRef.current === "chat")
          ? selectedSessionIdRef.current
          : null;
      const shouldNotify =
        attention &&
        shouldNotifySessionAttention(attention, targetSessionId, visibleSessionDetailId);
      setAcknowledgedSessionAttentionById((prev) => {
        if (!prev[targetSessionId]) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });
      setSessionAttentionById((prev) => {
        if (!attention || !shouldNotify) {
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
    availableSkills,
    isLoadingSkills,
    selectedRequiredSkillId,
    resetSessionView,
    abortRunAndResetSessionView,
    applySessionDetails,
    handleStop,
    handleAttachFiles,
    handleRemovePendingFile,
    handleAddPendingImages,
    handleRemovePendingLocalImage,
    handleSendMessage,
    handleSessionControlAction,
    handleQuickReply,
    handlePermissionResolve,
    handleFeishuAuthOpen,
    loadAvailableSkills,
    setSelectedRequiredSkillId,
  } = useChatRun({
    selectedModel,
    onSelectedModelChange: handleSessionDetailModelChange,
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
      setSelectedModel(model);
      rememberSelectedModelOverride(model);
    },
    [persistDefaultModel, rememberSelectedModelOverride]
  );

  useEffect(() => {
    setClientStorageItem("ripple.workbench.inspectorCollapsed", String(isInspectorCollapsed));
  }, [isInspectorCollapsed]);

  useEffect(() => {
    selectedSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    isMobileLayoutRef.current = isMobileLayout;
  }, [isMobileLayout]);

  useEffect(() => {
    mobileSessionModeRef.current = mobileSessionMode;
  }, [mobileSessionMode]);

  useEffect(() => {
    sessionActionsRef.current = {
      getSessionId: () => sessionId,
      ensureSession: (model) => ensureSession(model, activeContextFolderPath),
      createSession: async (model) =>
        (await createNewSession(model, activeContextFolderPath, { refresh: false }))?.sessionId ??
        null,
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
    createNewSession,
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
      selectedModelOverrideBySessionRef.current = {};
      const preferredModel = selectPreferredModel(models, getStoredDefaultModel(newUid));
      setDefaultModel(preferredModel);
      setSelectedModel(preferredModel);
      setSessionAttentionById({});
      setAcknowledgedSessionAttentionById({});
      setActiveContextFolderPath(null);
      setPendingMobileSession(null);
      mobileSessionSelectionRequestRef.current += 1;
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
        } catch (err) {
          if (err instanceof AuthError) throw err;
          console.error("Failed to fetch models:", err);
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
      setAuthUserIdError(t("auth.userIdInvalid"));
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
      selectedModelOverrideBySessionRef.current = {};
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
      selectedModelOverrideBySessionRef.current = {};
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
      const summaryAttention = summary
        ? sessionAttentionFromStatus(
            sessionStatusToWorkbenchStatus(summary.status),
            summary.pendingApprovalCount
          )
        : null;
      const acknowledgedAttention =
        storedAttention === "needs_input" || storedAttention === "error"
          ? storedAttention
          : summaryAttention === "needs_input" || summaryAttention === "error"
            ? summaryAttention
            : null;

      setSessionAttentionById((prev) => {
        if (!prev[targetSessionId]) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });

      if (acknowledgedAttention) {
        setAcknowledgedSessionAttentionById((prev) =>
          prev[targetSessionId] === acknowledgedAttention
            ? prev
            : { ...prev, [targetSessionId]: acknowledgedAttention }
        );
      }
    },
    [sessionAttentionById, sessionSummaries]
  );

  // ── Session switch ──
  const handleSwitchSession = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      const switched = await switchSession(targetSessionId);
      if (switched) {
        acknowledgeSessionAttention(targetSessionId);
        setSessionScrollToBottomRequest((request) => request + 1);
      }
      return switched;
    },
    [acknowledgeSessionAttention, switchSession]
  );

  // ── New session ──
  const handleNewSession = async () => {
    setPendingMobileSession(null);
    mobileSessionSelectionRequestRef.current += 1;
    const session = await createNewSession(defaultModel, activeContextFolderPath, {
      refresh: false,
    });
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
      setPendingMobileSession(null);
      mobileSessionSelectionRequestRef.current += 1;
      setMobileFilesReturnToChat(false);
      setMobileSessionRestoreScrollTop(null);
      if (view !== "files") setPendingWorkspaceFileOpen(null);
      if (view !== "skills") setIsSkillsMobileBackGestureActive(false);
      if (view === activeView && view === "skills") {
        setSkillsResetToRootRequest((request) => request + 1);
      }
      setMobileMotionDirection(0);
      setActiveView(view);
      if (view === "sessions") {
        setMobileSessionMode("list");
        if (sessionId) {
          void handleSwitchSession(sessionId);
        }
      }
    },
    [activeView, handleSwitchSession, sessionId]
  );
  const handleReturnFromMobileFiles = useCallback(() => {
    setPendingMobileSession(null);
    mobileSessionSelectionRequestRef.current += 1;
    setMobileFilesReturnToChat(false);
    setPendingWorkspaceFileOpen(null);
    setActiveView("sessions");
    setMobileMotionDirection(1);
    setMobileSessionMode("chat");
  }, []);
  const handleOpenChatWithPrompt = useCallback(
    (prompt: string, options?: { autoSend?: boolean; newSession?: boolean }) => {
      setPendingMobileSession(null);
      mobileSessionSelectionRequestRef.current += 1;
      setMobileFilesReturnToChat(false);
      setPendingWorkspaceFileOpen(null);
      setActiveView("sessions");
      setMobileMotionDirection(1);
      setMobileSessionMode("chat");
      setInput(prompt);
      if (options?.autoSend) {
        void handleSendMessage(prompt, { newSession: options.newSession });
      }
    },
    [handleSendMessage, setInput]
  );
  const handleOpenSessionAction = useCallback(
    (action: SessionControlAction, label: string) => {
      setPendingMobileSession(null);
      mobileSessionSelectionRequestRef.current += 1;
      setMobileFilesReturnToChat(false);
      setPendingWorkspaceFileOpen(null);
      setActiveView("sessions");
      setMobileMotionDirection(1);
      setMobileSessionMode("chat");
      void handleSessionControlAction(action, label);
    },
    [handleSessionControlAction]
  );
  const handleOpenMobileSessionList = useCallback(() => {
    setPendingMobileSession(null);
    mobileSessionSelectionRequestRef.current += 1;
    setMobileFilesReturnToChat(false);
    setPendingWorkspaceFileOpen(null);
    setMobileSessionRestoreScrollTop(null);
    setActiveView("sessions");
    setMobileMotionDirection(-1);
    setMobileSessionMode("list");
  }, []);

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
  const sessionDetailVisibleForAttention =
    activeView === "sessions" && (!isMobileLayout || mobileSessionMode === "chat");
  const openSessionIdForAttention = sessionDetailVisibleForAttention ? sessionId : null;
  const sessionListVisibleForStableOrder =
    activeView === "sessions" && (!isMobileLayout || mobileSessionMode === "list");
  const displayWorkbenchSessions = useMemo(() => {
    const markedSessions = applySessionAttentionMarkers(
      mergedWorkbenchSessions,
      sessionAttentionById,
      openSessionIdForAttention,
      acknowledgedSessionAttentionById
    );
    const orderedSessions = sessionListVisibleForStableOrder
      ? stabilizeWorkbenchSessionOrder(displayWorkbenchSessionOrderRef.current, markedSessions)
      : markedSessions;
    displayWorkbenchSessionOrderRef.current = orderedSessions;
    return orderedSessions;
  }, [
    acknowledgedSessionAttentionById,
    mergedWorkbenchSessions,
    openSessionIdForAttention,
    sessionListVisibleForStableOrder,
    sessionAttentionById,
  ]);
  const selectedWorkbenchSession = sessionId
    ? displayWorkbenchSessions.find((session) => session.sessionId === sessionId) || null
    : null;
  const shouldPatchSelectedSessionModel = Boolean(sessionId && selectedWorkbenchSession);
  const handleSelectModel = useCallback(
    (model: string) => {
      setSelectedModel(model);
      rememberSelectedModelOverride(model);
      persistDefaultModel(model);
      if (sessionId && shouldPatchSelectedSessionModel) {
        void updateSessionById(sessionId, { model });
      }
      setOpenModelDropdown(null);
    },
    [
      persistDefaultModel,
      rememberSelectedModelOverride,
      sessionId,
      shouldPatchSelectedSessionModel,
      updateSessionById,
    ]
  );
  const handleToggleComposerModelDropdown = useCallback(() => {
    setOpenModelDropdown((open) => (open === "composer" ? null : "composer"));
  }, []);
  const handleCloseModelDropdown = useCallback(() => {
    setOpenModelDropdown(null);
  }, []);
  const activePendingMobileSession =
    pendingMobileSession && pendingMobileSession.sessionId !== sessionId
      ? pendingMobileSession
      : null;
  const isMobileSessionSwitchPending = Boolean(activePendingMobileSession);
  const sessionPageSession = activePendingMobileSession || selectedWorkbenchSession;
  const sessionPageSessionId = activePendingMobileSession?.sessionId ?? sessionId;
  const sessionPageMessages = isMobileSessionSwitchPending ? [] : messages;
  const sessionPageTimelineEvents = isMobileSessionSwitchPending ? [] : timelineEvents;
  const sessionPagePlanSteps = isMobileSessionSwitchPending ? [] : planSteps;
  const sessionPagePlanProgress = isMobileSessionSwitchPending ? null : planProgress;
  const sessionPageTokenUsage = isMobileSessionSwitchPending ? emptyUsage : tokenUsage;
  const sessionPageLastContextTokens = isMobileSessionSwitchPending ? 0 : lastContextTokens;
  const sessionPageInput = isMobileSessionSwitchPending ? "" : input;
  const sessionPagePendingFiles = isMobileSessionSwitchPending ? [] : pendingFiles;
  const sessionPagePendingLocalImages = isMobileSessionSwitchPending ? [] : pendingLocalImages;
  const sessionPageIsUploadingFiles = isMobileSessionSwitchPending ? false : isUploadingFiles;
  const sessionPageUploadError = isMobileSessionSwitchPending ? null : attachmentUploadError;
  const sessionPageSelectedModel = activePendingMobileSession?.model || selectedModel;
  const sessionPageContextFolderPath =
    activePendingMobileSession?.contextFolderPath ?? activeContextFolderPath;
  const sessionPageIsGenerating = Boolean(
    sessionPageSessionId && runningSessionIds.includes(sessionPageSessionId)
  );
  const isComposerBlocked = sessionPageSession?.status === "compacting";

  const handleSelectMobileSession = useCallback(
    async (targetSessionId: string) => {
      const targetSession = displayWorkbenchSessions.find(
        (session) => session.sessionId === targetSessionId
      ) || {
        sessionId: targetSessionId,
        title: "Loading session",
        pinned: false,
        status: "idle" as const,
        model: selectedModel,
        lastActivityAt: new Date().toISOString(),
        messageCount: 0,
        changedFileCount: 0,
        pendingApprovalCount: 0,
      };
      const requestId = mobileSessionSelectionRequestRef.current + 1;
      mobileSessionSelectionRequestRef.current = requestId;

      setMobileFilesReturnToChat(false);
      setPendingWorkspaceFileOpen(null);
      setActiveView("sessions");
      setMobileMotionDirection(1);
      if (targetSessionId !== sessionId) {
        setPendingMobileSession(targetSession);
      } else {
        setPendingMobileSession(null);
      }
      setMobileSessionMode("chat");

      const switched = await handleSwitchSession(targetSessionId);
      if (mobileSessionSelectionRequestRef.current !== requestId) return;
      setPendingMobileSession(null);
      if (!switched) {
        setMobileSessionMode("list");
      }
    },
    [displayWorkbenchSessions, handleSwitchSession, selectedModel, sessionId]
  );

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
        setActiveContextFolderPath(updated.contextFolderPath ?? nextContextFolderPath);
        setActiveView("sessions");
        setMobileMotionDirection(1);
        setMobileSessionMode("chat");
      }
    },
    [activeContextFolderPath, selectedWorkbenchSession, sessionId, updateSessionById]
  );

  const handleOpenTaskSession = useCallback(
    (targetSessionId: string) => {
      setPendingMobileSession(null);
      mobileSessionSelectionRequestRef.current += 1;
      setMobileFilesReturnToChat(false);
      setPendingWorkspaceFileOpen(null);
      setActiveView("sessions");
      setMobileMotionDirection(1);
      setMobileSessionMode("chat");
      void handleSwitchSession(targetSessionId);
    },
    [handleSwitchSession]
  );

  const renderSessionPage = () => (
    <SessionPage
      userId={userId}
      session={sessionPageSession}
      messages={sessionPageMessages}
      timelineEvents={sessionPageTimelineEvents}
      planProgress={sessionPagePlanProgress}
      planSteps={sessionPagePlanSteps}
      tokenUsage={sessionPageTokenUsage}
      lastContextTokens={sessionPageLastContextTokens}
      input={sessionPageInput}
      pendingFiles={sessionPagePendingFiles}
      pendingLocalImages={sessionPagePendingLocalImages}
      isUploadingFiles={sessionPageIsUploadingFiles}
      uploadError={sessionPageUploadError}
      isGenerating={sessionPageIsGenerating}
      isSessionLoading={isMobileSessionSwitchPending}
      isComposerBlocked={isComposerBlocked}
      focusToken={inputFocusToken}
      selectedModel={sessionPageSelectedModel}
      models={models}
      isModelDropdownOpen={openModelDropdown === "composer"}
      availableSkills={availableSkills}
      selectedRequiredSkillId={selectedRequiredSkillId}
      isLoadingSkills={isLoadingSkills}
      sessionId={sessionPageSessionId}
      scrollToBottomRequest={sessionScrollToBottomRequest}
      contextFolderPath={sessionPageContextFolderPath}
      onSelectWorkspaceFolder={handleSelectChatFolder}
      onNewSession={handleNewSession}
      onInputChange={setInput}
      onAttachFiles={handleAttachFiles}
      onRemovePendingFile={handleRemovePendingFile}
      onAddPendingImages={handleAddPendingImages}
      onRemovePendingLocalImage={handleRemovePendingLocalImage}
      onToggleModelDropdown={handleToggleComposerModelDropdown}
      onCloseModelDropdown={handleCloseModelDropdown}
      onSelectModel={handleSelectModel}
      onLoadSkills={loadAvailableSkills}
      onSelectRequiredSkill={setSelectedRequiredSkillId}
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
  );
  const mobileSessionList = (
    <MobileSessionsPage
      sessions={displayWorkbenchSessions}
      isLoading={isLoadingSessions}
      sessionLoadError={sessionLoadError}
      selectedSessionId={sessionId}
      onNewSession={handleNewSession}
      onSelectSession={(selectedSessionId) => void handleSelectMobileSession(selectedSessionId)}
      onDeleteSession={handleDeleteSession}
      onUpdateSession={updateSessionById}
    />
  );
  const mobileSessionChat = renderSessionPage();
  const sessionsMobileNav = (
    <MobileTabBar activeView={activeView} onSelectView={handleSelectView} placement="absolute" />
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
        onAuthExpired={handleAuthExpired}
      />
    ) : activeView === "files" ? (
      <FilesPage
        userId={userId}
        refreshToken={workspaceRefreshToken}
        onBack={mobileFilesReturnToChat ? handleReturnFromMobileFiles : undefined}
        openFileRequest={pendingWorkspaceFileOpen}
        onOpenFileRequestConsumed={handlePendingWorkspaceFileOpenConsumed}
      />
    ) : activeView === "tasks" ? (
      <TasksPage
        key={`tasks:${userId}`}
        userId={userId}
        onAuthExpired={handleAuthExpired}
        onOpenSession={handleOpenTaskSession}
      />
    ) : activeView === "skills" ? (
      <SkillsPage
        userId={userId}
        onOpenChat={handleOpenChatWithPrompt}
        onOpenSessionAction={handleOpenSessionAction}
        onConnectorStateChange={loadSessions}
        onMobileBackGestureScopeChange={setIsSkillsMobileBackGestureActive}
        resetToRootRequest={skillsResetToRootRequest}
      />
    ) : (
      <div className="h-full min-h-0">
        <MobileSessionStack
          mode={mobileSessionMode}
          list={mobileSessionList}
          listNav={sessionsMobileNav}
          chat={mobileSessionChat}
          onOpenList={handleOpenMobileSessionList}
        />
        <div
          data-ripple-session-layout="desktop"
          className="relative hidden h-full min-h-0 lg:flex"
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
                className="group absolute top-0 right-0 bottom-0 z-20 flex w-2 translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#F0F5FF] focus:bg-[#F0F5FF]"
              >
                <span className="h-12 w-0.5 rounded-full bg-[#1456F0] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-ripple-panel-edge-handle="session-list"
              onClick={() => setIsSessionRailCollapsed(false)}
              aria-label={t("common.expandSessionList")}
              title={t("common.expandSessionList")}
              className={`absolute top-1/2 left-0 z-30 hidden -translate-y-1/2 ${WORKBENCH_ICON_BUTTON_CLASS} !h-14 !w-7 !rounded-l-none !rounded-r-xl border-l-0 border-[#BACEFD] text-[#1456F0] shadow-[0_4px_12px_rgba(31,35,41,0.08)] hover:border-[#8FB1FF] hover:bg-[#F0F5FF] focus-visible:ring-2 focus-visible:ring-[#BACEFD] focus-visible:outline-none lg:inline-flex`}
            >
              <ChevronRight size={16} />
            </button>
          )}
          <div className="h-full min-w-0 flex-1">{renderSessionPage()}</div>
        </div>
      </div>
    );
  const mobileNav =
    activeView === "sessions" ? null : (
      <MobileTabBar activeView={activeView} onSelectView={handleSelectView} />
    );
  const mobileMotionStage = activeView === "sessions" ? "sessions:page" : `${activeView}:page`;
  const animatedMainContent = (
    <AnimatePresence initial={false} custom={mobileMotionDirection}>
      <motion.div
        key={mobileMotionStage}
        data-ripple-mobile-motion-stage={mobileMotionStage}
        custom={mobileMotionDirection}
        variants={reduceMotion ? reducedMobilePageVariants : mobilePageVariants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={reduceMotion ? reducedMotionTransition : mobilePageSwitchTransition}
        className="h-full min-h-0"
      >
        <Suspense fallback={<LazyWorkbenchFallback />}>{mainContent}</Suspense>
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
          setPasswordInput("");
          setKeyInput("");
          setInviteCodeInput("");
          setInviteDisplayNameInput("");
          setAuthUserIdInput(initialLoginUserIdInput(getUserId()));
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
            <Suspense fallback={null}>
              <InspectorPanel
                userId={userId}
                refreshToken={workspaceRefreshToken}
                onCollapse={() => setIsInspectorCollapsed(true)}
                openFileRequest={pendingWorkspaceFileOpen}
                onOpenFileRequestConsumed={handlePendingWorkspaceFileOpenConsumed}
              />
            </Suspense>
          ) : null
        }
        mobileNav={mobileNav}
      />
    </>
  );
}
