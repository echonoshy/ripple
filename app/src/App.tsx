import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AlertTriangle, KeyRound, UserRound } from "lucide-react";
import {
  fetchModels,
  getApiKey,
  setApiKey,
  clearApiKey,
  getUserId,
  setUserId,
  AuthError,
} from "@/lib/api";
import RippleIcon from "@/components/icons/RippleIcon";
import SettingsModal from "@/components/SettingsModal";
import AutomationsPage from "@/components/workbench/AutomationsPage";
import ConnectorsPage from "@/components/workbench/ConnectorsPage";
import FilesPage from "@/components/workbench/FilesPage";
import HomePage from "@/components/workbench/HomePage";
import InspectorPanel from "@/components/workbench/InspectorPanel";
import MobileSessionsPage from "@/components/workbench/MobileSessionsPage";
import MobileTabBar from "@/components/workbench/MobileTabBar";
import SessionPage from "@/components/workbench/SessionPage";
import WorkbenchShell from "@/components/workbench/WorkbenchShell";
import WorkspaceNav from "@/components/workbench/WorkspaceNav";
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
} from "@/lib/workbench";
import { shouldShowInspector, type WorkspaceView } from "@/lib/workspaceViews";
import type { SessionAttention } from "@/types";
import { sortModelOptions } from "@/lib/models";

export default function Home() {
  // ── Auth state ──
  const [authState, setAuthState] = useState<"checking" | "needs_auth" | "authenticated">(() =>
    getApiKey() ? "authenticated" : "needs_auth"
  );
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [authUserIdInput, setAuthUserIdInput] = useState(() =>
    initialLoginUserIdInput(getUserId())
  );
  const [authUserIdError, setAuthUserIdError] = useState<string | null>(null);

  // ── Model state ──
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState("codex-medium");
  const [openModelDropdown, setOpenModelDropdown] = useState<"composer" | null>(null);

  // ── User identity ──
  const [userId, setUserIdState] = useState<string>(() => getUserId());

  // ── UI state ──
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isNavCollapsed, setIsNavCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("ripple.workbench.navCollapsed") === "true";
  });
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("ripple.workbench.inspectorCollapsed") === "true";
  });
  const [mobileSessionMode, setMobileSessionMode] = useState<"list" | "chat">("list");
  const [sessionScrollToBottomRequest, setSessionScrollToBottomRequest] = useState(0);
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [activeView, setActiveView] = useState<WorkspaceView>("sessions");
  const [sessionAttentionById, setSessionAttentionById] = useState<
    Record<string, SessionAttention | undefined>
  >({});
  const selectedSessionIdRef = useRef<string | null>(null);
  const activeViewRef = useRef<WorkspaceView>("sessions");

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
    setAuthErrorMsg(message);
    setAuthUserIdInput(initialLoginUserIdInput(getUserId()));
    setAuthUserIdError(null);
    clearStoredCurrentSessionId();
  }, []);

  const handleWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshToken((prev) => prev + 1);
  }, []);

  const getSessionActions = useCallback(() => sessionActionsRef.current, []);

  const acknowledgeSessionCompletion = useCallback((targetSessionId: string) => {
    setSessionAttentionById((prev) => {
      if (prev[targetSessionId] !== "completed") return prev;
      const next = { ...prev };
      delete next[targetSessionId];
      return next;
    });
  }, []);

  const handleSessionAttention = useCallback(
    (targetSessionId: string, attention: SessionAttention | null) => {
      setSessionAttentionById((prev) => {
        const sessionIsOpen =
          selectedSessionIdRef.current === targetSessionId && activeViewRef.current === "sessions";
        const shouldClear = !attention || (attention === "completed" && sessionIsOpen);

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

  const handleSessionActivated = useCallback(() => {
    setActiveView("sessions");
    setIsSidebarOpen(false);
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
    onApplySessionDetails: applySessionDetails,
    onNewSessionView: resetSessionView,
    onDeleteCurrentSession: resetSessionView,
    onSessionActivated: handleSessionActivated,
  });

  useEffect(() => {
    window.localStorage.setItem("ripple.workbench.navCollapsed", String(isNavCollapsed));
  }, [isNavCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(
      "ripple.workbench.inspectorCollapsed",
      String(isInspectorCollapsed)
    );
  }, [isInspectorCollapsed]);

  useEffect(() => {
    selectedSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    sessionActionsRef.current = {
      getSessionId: () => sessionId,
      ensureSession,
      loadSessions,
      clearCurrentSessionContext,
      compactCurrentSessionContext,
      stopCurrentSession,
      stopSession: stopSessionById,
    };
  }, [
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
      try {
        setUserId(newUid);
      } catch {
        return;
      }
      setUserIdState(newUid);
      setSessionAttentionById({});
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
      }>;
      const { userId: targetUserId } = customEvent.detail;

      setIsInspectorCollapsed(false);

      if (targetUserId && targetUserId !== userId) {
        void handleUserIdChange(targetUserId);
      }
    };
    window.addEventListener("open-workspace-file", handleOpenWorkspaceFile);
    return () => {
      window.removeEventListener("open-workspace-file", handleOpenWorkspaceFile);
    };
  }, [userId, handleUserIdChange]);

  // ── Init on auth ──
  useEffect(() => {
    if (authState !== "authenticated") return;
    (async () => {
      try {
        const fetched = sortModelOptions(await fetchModels());
        setModels(fetched);
        if (fetched.length > 0) {
          setSelectedModel(fetched.find((m) => m.id === "codex-medium")?.id || fetched[0].id);
        }
        const loadedSessions = await loadSessions();
        if (loadedSessions.length > 0) {
          await restoreStoredSession(loadedSessions);
        }
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired("API key 无效，请重新输入");
        }
      }
    })();
  }, [authState, handleAuthExpired, loadSessions, restoreStoredSession]);

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
      setAuthUserIdError("Use letters, numbers, underscores, or hyphens.");
      return;
    }
    if (nextUserId !== userId) {
      setUserIdState(nextUserId);
      setSessionAttentionById({});
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

  // ── Session switch ──
  const handleSwitchSession = useCallback(
    async (targetSessionId: string) => {
      const switched = await switchSession(targetSessionId);
      if (switched) {
        acknowledgeSessionCompletion(targetSessionId);
        setSessionScrollToBottomRequest((request) => request + 1);
      }
    },
    [acknowledgeSessionCompletion, switchSession]
  );

  // ── New session ──
  const handleNewSession = async () => {
    await createNewSession();
    setActiveView("sessions");
    setMobileSessionMode("chat");
  };

  const handleUpdateSessionSettings = useCallback(
    async (updates: { title?: string; pinned?: boolean }) => {
      if (!sessionId) return null;
      return updateSessionById(sessionId, updates);
    },
    [sessionId, updateSessionById]
  );

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
    }
  };

  const handleSelectView = useCallback(
    (view: WorkspaceView) => {
      setActiveView(view);
      setIsSidebarOpen(false);
      if (view === "sessions") {
        setMobileSessionMode("list");
      }
      if (view === "sessions" && sessionId) {
        acknowledgeSessionCompletion(sessionId);
      }
    },
    [acknowledgeSessionCompletion, sessionId]
  );
  const handleOpenMobileSessionList = useCallback(() => {
    handleSelectView("sessions");
  }, [handleSelectView]);
  const handleSelectMobileSession = useCallback(
    async (targetSessionId: string) => {
      await handleSwitchSession(targetSessionId);
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
  const inferredCurrentSession = useMemo(
    () =>
      sessionId && !selectedExistingSession
        ? {
            sessionId,
            title: "Current session",
            pinned: false,
            status: selectedSessionRuntimeStatus || ("idle" as const),
            model: selectedModel,
            lastActivityAt: new Date().toISOString(),
            messageCount: messages.length,
            changedFileCount: 0,
            pendingApprovalCount: 0,
          }
        : null,
    [
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
        activeView === "sessions" ? sessionId : null
      ),
    [activeView, mergedWorkbenchSessions, sessionAttentionById, sessionId]
  );
  const selectedWorkbenchSession = sessionId
    ? displayWorkbenchSessions.find((session) => session.sessionId === sessionId) || null
    : null;
  const isComposerBlocked = selectedWorkbenchSession?.status === "compacting";
  const mainContent =
    activeView === "home" ? (
      <HomePage
        userId={userId}
        sessions={displayWorkbenchSessions}
        onSelectView={handleSelectView}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onUserIdChange={handleUserIdChange}
      />
    ) : activeView === "files" ? (
      <FilesPage userId={userId} refreshToken={workspaceRefreshToken} />
    ) : activeView === "automations" ? (
      <AutomationsPage selectedModel={selectedModel} onAuthExpired={handleAuthExpired} />
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
        <div className={mobileSessionMode === "chat" ? "h-full" : "hidden h-full lg:block"}>
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
            onNewSession={handleNewSession}
            onUpdateSessionSettings={handleUpdateSessionSettings}
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
            onSelectModel={(model) => {
              setSelectedModel(model);
              setOpenModelDropdown(null);
            }}
            onSend={handleSendMessage}
            onStop={handleStop}
            onQuickReply={handleQuickReply}
            onPermissionResolve={handlePermissionResolve}
            onFeishuAuthOpen={handleFeishuAuthOpen}
            feishuAuthWaiting={feishuAuthWaiting}
            onBackToMobileSessions={handleOpenMobileSessionList}
            isInspectorCollapsed={isInspectorCollapsed}
          />
        </div>
      </div>
    );
  const mobileNav =
    activeView === "sessions" && mobileSessionMode === "chat" ? null : (
      <MobileTabBar activeView={activeView} onSelectView={handleSelectView} />
    );

  // ═══════════════════════════════════════════════════════
  // AUTH SCREEN
  // ═══════════════════════════════════════════════════════
  if (authState !== "authenticated") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-white p-4 text-[#171a1f]">
        {authState === "needs_auth" && (
          <div className="mx-4 w-full max-w-sm">
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-8 shadow-[0_24px_70px_rgba(13,13,13,0.08)]">
              <div className="mb-8 flex flex-col items-center">
                <RippleIcon
                  size={72}
                  className="mb-5 h-[72px] w-[72px] rounded-2xl shadow-[0_18px_45px_rgba(13,13,13,0.18)]"
                />
                <h1 className="text-[28px] leading-tight font-semibold tracking-normal">Ripple</h1>
                <p className="mt-3 text-center text-sm text-[#687280]">
                  Enter your API key and optional User ID
                </p>
                <p className="mt-1 text-center font-[family-name:var(--font-cjk)] text-sm text-[#687280]">
                  User ID 留空时使用 default
                </p>
              </div>
              {authErrorMsg && (
                <div className="mb-4 flex items-center gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-sm font-medium text-[#cf222e]">
                  <AlertTriangle size={16} />
                  <span>{authErrorMsg}</span>
                </div>
              )}
              <form onSubmit={handleAuthSubmit}>
                <div className="relative mb-4">
                  <KeyRound
                    size={18}
                    className="absolute top-1/2 left-4 -translate-y-1/2 text-[#6e7781]"
                  />
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="Enter API key..."
                    className="w-full rounded-lg border border-[#e5e7eb] bg-white py-3 pr-4 pl-11 font-[family-name:var(--font-mono)] text-sm text-[#171a1f] outline-none focus:border-[#2463eb]"
                  />
                </div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-[#687280]">
                  <span>User ID</span>
                  <span className="font-[family-name:var(--font-cjk)] font-normal">
                    留空使用 default
                  </span>
                </div>
                <div className="relative mb-2">
                  <UserRound
                    size={18}
                    className="absolute top-1/2 left-4 -translate-y-1/2 text-[#6e7781]"
                  />
                  <input
                    type="text"
                    value={authUserIdInput}
                    onChange={(e) => {
                      setAuthUserIdInput(e.target.value);
                      if (authUserIdError) setAuthUserIdError(null);
                    }}
                    placeholder="default"
                    aria-label="User ID"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full rounded-lg border border-[#e5e7eb] bg-white py-3 pr-4 pl-11 font-[family-name:var(--font-mono)] text-sm text-[#171a1f] outline-none focus:border-[#2463eb]"
                  />
                </div>
                {authUserIdError && (
                  <div className="mb-3 text-xs font-medium text-[#cf222e]">{authUserIdError}</div>
                )}
                <button
                  type="submit"
                  disabled={!keyInput.trim()}
                  className="w-full rounded-lg border border-[#2463eb] bg-[#2463eb] py-3 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(36,99,235,0.18)] hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#dde2ea] disabled:bg-[#f7f8fa] disabled:text-[#8b8f94] disabled:shadow-none"
                >
                  Connect
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // MAIN APP
  // ═══════════════════════════════════════════════════════
  return (
    <>
      <WorkbenchShell
        isNavOpen={isSidebarOpen}
        onCloseNav={() => setIsSidebarOpen(false)}
        isNavCollapsed={isNavCollapsed}
        onExpandNav={() => setIsNavCollapsed(false)}
        isInspectorCollapsed={isInspectorCollapsed}
        onExpandInspector={() => setIsInspectorCollapsed(false)}
        nav={
          <WorkspaceNav
            sessions={displayWorkbenchSessions}
            selectedSessionId={sessionId}
            activeView={activeView}
            isLoading={isLoadingSessions}
            sessionLoadError={sessionLoadError}
            isGenerating={isGenerating}
            userId={userId}
            onUserIdChange={handleUserIdChange}
            onNewSession={handleNewSession}
            onSelectView={handleSelectView}
            onSelectSession={(selectedSessionId) => {
              void handleSwitchSession(selectedSessionId);
              setMobileSessionMode("chat");
              setIsSidebarOpen(false);
            }}
            onDeleteSession={handleDeleteSession}
            onUpdateSession={updateSessionById}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onCollapse={() => setIsNavCollapsed(true)}
          />
        }
        content={mainContent}
        inspector={
          shouldShowInspector(activeView) ? (
            <InspectorPanel
              userId={userId}
              refreshToken={workspaceRefreshToken}
              onCollapse={() => setIsInspectorCollapsed(true)}
            />
          ) : null
        }
        mobileNav={mobileNav}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        apiKey={getApiKey()}
        userId={userId}
        onUserIdChange={handleUserIdChange}
        onApiKeyChange={() => {
          clearApiKey();
          clearStoredCurrentSessionId();
          setAuthUserIdInput(initialLoginUserIdInput(getUserId()));
          setAuthUserIdError(null);
          setIsSettingsOpen(false);
          setAuthState("needs_auth");
        }}
      />
    </>
  );
}
