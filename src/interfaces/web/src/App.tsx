import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AlertTriangle, KeyRound } from "lucide-react";
import {
  Message,
  UsageInfo,
  TaskDetail,
  TaskInfo,
  TaskProgress,
  TaskSummary,
  WorkbenchTimelineEvent,
} from "@/types";
import {
  clearTaskContext,
  createTask,
  sendChatMessage,
  stopTask,
  fetchModels,
  getApiKey,
  setApiKey,
  clearApiKey,
  getUserId,
  setUserId,
  AuthError,
  fetchTasks,
  fetchTaskDetails,
  deleteTask,
  resolveTaskPermissionRequest,
  uploadWorkspaceAttachment,
} from "@/lib/api";
import RippleIcon from "@/components/icons/RippleIcon";
import SettingsModal from "@/components/SettingsModal";
import ConnectorsPage from "@/components/workbench/ConnectorsPage";
import FilesPage from "@/components/workbench/FilesPage";
import HomePage from "@/components/workbench/HomePage";
import InspectorPanel from "@/components/workbench/InspectorPanel";
import MobileTabBar from "@/components/workbench/MobileTabBar";
import TaskPage from "@/components/workbench/TaskPage";
import WorkbenchShell from "@/components/workbench/WorkbenchShell";
import WorkspaceNav from "@/components/workbench/WorkspaceNav";
import { describeChatFilesForDisplay, type ChatFileRef } from "@/lib/chatInput";
import {
  applyTaskPlanUpdate,
  applyTaskUpdate,
  clearTaskPlanState,
  upsertTask,
} from "@/lib/chatState";
import { copyTextToClipboard } from "@/lib/clipboard";
import { bumpInputFocusToken } from "@/lib/inputFocus";
import {
  clearStoredCurrentSessionId,
  getStoredCurrentSessionId,
  pickInitialSessionId,
  setStoredCurrentSessionId,
} from "@/lib/sessionPersistence";
import {
  applyCurrentSessionRuntimeStatus,
  codexRuntimeEventToTimelineEvent,
  createWorkbenchSessionsFromTaskSummaries,
  extractChangedFilePaths,
  messagesToTimelineEvents,
} from "@/lib/workbench";
import { shouldShowInspector, type WorkspaceView } from "@/lib/workspaceViews";

export default function Home() {
  // ── Auth state ──
  const [authState, setAuthState] = useState<"checking" | "needs_auth" | "authenticated">(() =>
    getApiKey() ? "authenticated" : "needs_auth"
  );
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [keyInput, setKeyInput] = useState("");

  // ── Session & chat state ──
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingFiles, setPendingFiles] = useState<ChatFileRef[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [sessionSummaries, setSessionSummaries] = useState<TaskSummary[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [runtimeTimelineEvents, setRuntimeTimelineEvents] = useState<WorkbenchTimelineEvent[]>([]);

  // ── Model state ──
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState("codex-medium");
  const [openModelDropdown, setOpenModelDropdown] = useState<"composer" | null>(null);

  // ── User identity ──
  const [userId, setUserIdState] = useState<string>(() => getUserId());

  // ── UI state ──
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [activeView, setActiveView] = useState<WorkspaceView>("sessions");

  // ── Token tracking ──
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  const [lastContextTokens, setLastContextTokens] = useState(0);

  // ── Plan tracking ──
  const [taskSteps, setTaskSteps] = useState<TaskInfo[]>([]);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);

  const activeRequestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ── Load sessions ──
  const loadSessions = useCallback(async (): Promise<TaskSummary[]> => {
    if (authState !== "authenticated") return [];
    try {
      setIsLoadingSessions(true);
      const loadedSessions = await fetchTasks();
      setSessionSummaries(loadedSessions);
      return loadedSessions;
    } catch {
      return [];
    } finally {
      setIsLoadingSessions(false);
    }
  }, [authState]);

  const applyTaskDetails = useCallback((details: TaskDetail) => {
    setSessionId(details.session_id);
    setSelectedModel(details.model);
    setMessages(mapBackendMessages(details));
    setRuntimeTimelineEvents([]);
    setPendingFiles([]);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setLastContextTokens(0);
    setTaskSteps(details.task_steps || []);
    setTaskProgress(details.task_progress || null);
    setStoredCurrentSessionId(undefined, details.session_id);
    setWorkspaceRefreshToken((prev) => prev + 1);
  }, []);

  const restoreStoredSession = useCallback(
    async (availableSessions: TaskSummary[]) => {
      const storedSessionId = getStoredCurrentSessionId();
      const restorableSessionId = pickInitialSessionId(storedSessionId, availableSessions);

      if (!restorableSessionId) {
        clearStoredCurrentSessionId();
        return;
      }

      const details = await fetchTaskDetails(restorableSessionId);
      if (!details) {
        clearStoredCurrentSessionId();
        return;
      }

      applyTaskDetails(details);
    },
    [applyTaskDetails]
  );

  const handleUserIdChange = useCallback(
    async (newUid: string) => {
      try {
        setUserId(newUid);
      } catch {
        return;
      }
      setUserIdState(newUid);
      abortControllerRef.current?.abort();
      activeRequestIdRef.current += 1;
      setSessionId(null);
      setMessages([]);
      setRuntimeTimelineEvents([]);
      setPendingFiles([]);
      setSessionSummaries([]);
      setTaskSteps([]);
      setTaskProgress(null);
      setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      setLastContextTokens(0);
      setIsGenerating(false);
      clearStoredCurrentSessionId();
      if (authState === "authenticated") {
        const loaded = await loadSessions();
        console.info(`[ripple] switched to user "${newUid}", loaded ${loaded.length} sessions`);
        if (loaded.length > 0) {
          await restoreStoredSession(loaded);
        }
      }
    },
    [authState, loadSessions, restoreStoredSession]
  );

  // ── Init on auth ──
  useEffect(() => {
    if (authState !== "authenticated") return;
    (async () => {
      try {
        const fetched = await fetchModels();
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
          clearApiKey();
          setAuthState("needs_auth");
          setAuthErrorMsg("API Key 无效，请重新输入");
          clearStoredCurrentSessionId();
        }
      }
    })();
  }, [authState, loadSessions, restoreStoredSession]);

  // ── Auth submit ──
  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    setApiKey(keyInput.trim());
    setKeyInput("");
    setAuthErrorMsg("");
    setAuthState("authenticated");
  };

  // ── Session switch ──
  const handleSwitchSession = async (targetSessionId: string) => {
    if (targetSessionId === sessionId || isGenerating) return;
    try {
      const details = await fetchTaskDetails(targetSessionId);
      if (!details) return;
      applyTaskDetails(details);
      setActiveView("sessions");
      setIsSidebarOpen(false);
    } catch (err) {
      console.error("Error switching session:", err);
    }
  };

  // ── New session ──
  const handleNewSession = async () => {
    if (isGenerating) return;
    setMessages([]);
    setRuntimeTimelineEvents([]);
    setPendingFiles([]);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setLastContextTokens(0);
    setTaskSteps([]);
    setTaskProgress(null);
    try {
      const task = await createTask();
      setSessionId(task.session_id);
      setStoredCurrentSessionId(undefined, task.session_id);
      setActiveView("sessions");
      await loadSessions();
    } catch (err) {
      if (err instanceof AuthError) {
        clearApiKey();
        setAuthState("needs_auth");
        setAuthErrorMsg("API Key 已失效");
        clearStoredCurrentSessionId();
      }
    }
  };

  // ── Delete session ──
  const handleDeleteSession = async (targetSessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isGenerating) return;
    if (await deleteTask(targetSessionId)) {
      setSessionSummaries((prev) =>
        prev.filter((session) => session.session_id !== targetSessionId)
      );
      if (getStoredCurrentSessionId() === targetSessionId) {
        clearStoredCurrentSessionId();
      }
      if (targetSessionId === sessionId) {
        setSessionId(null);
        setMessages([]);
        setRuntimeTimelineEvents([]);
        setPendingFiles([]);
        setTaskSteps([]);
        setTaskProgress(null);
      }
    }
  };

  // ── Stop generation ──
  const handleStop = useCallback(async () => {
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (sessionId) {
      await stopTask(sessionId);
    }
    setIsGenerating(false);
    setInputFocusToken((prev) => bumpInputFocusToken(prev));
  }, [sessionId]);

  const resetCurrentContextView = useCallback(() => {
    setMessages([]);
    setRuntimeTimelineEvents([]);
    setPendingFiles([]);
    setInput("");
    setTaskSteps([]);
    setTaskProgress(null);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setLastContextTokens(0);
  }, []);

  const handleClearContext = useCallback(async () => {
    if (isGenerating) return;
    try {
      if (sessionId) {
        const ok = await clearTaskContext(sessionId);
        if (!ok) throw new Error("Failed to clear session context");
      }
      resetCurrentContextView();
      setInputFocusToken((prev) => bumpInputFocusToken(prev));
      await loadSessions();
    } catch (err) {
      if (err instanceof AuthError) {
        clearApiKey();
        setAuthState("needs_auth");
        setAuthErrorMsg("API Key 已失效");
        clearStoredCurrentSessionId();
        return;
      }
      console.error("Clear context error:", err);
    }
  }, [isGenerating, loadSessions, resetCurrentContextView, sessionId]);

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (isGenerating || files.length === 0) return;
      try {
        const uploaded = await Promise.all(files.map((file) => uploadWorkspaceAttachment(file)));
        setPendingFiles((prev) => {
          const next = new Map(prev.map((file) => [file.path, file]));
          for (const file of uploaded) {
            next.set(file.path, {
              path: file.path,
              name: file.name,
              mime_type: file.mime_type,
              kind: file.kind,
            });
          }
          return [...next.values()];
        });
        setWorkspaceRefreshToken((prev) => prev + 1);
        setInputFocusToken((prev) => bumpInputFocusToken(prev));
      } catch (err) {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState("needs_auth");
          setAuthErrorMsg("API Key 已失效");
          clearStoredCurrentSessionId();
          return;
        }
        console.error("Attachment upload error:", err);
      }
    },
    [isGenerating]
  );

  const handleRemovePendingFile = useCallback((path: string) => {
    setPendingFiles((prev) => prev.filter((file) => file.path !== path));
  }, []);

  // ── Send message ──
  const handleSendMessage = useCallback(
    async (overrideText?: string) => {
      const text = typeof overrideText === "string" ? overrideText.trim() : input.trim();
      const filesForSend = typeof overrideText === "string" ? [] : pendingFiles;
      if (text === "/clear") {
        await handleClearContext();
        return;
      }
      if ((!text && filesForSend.length === 0) || isGenerating) return;
      const requestId = activeRequestIdRef.current + 1;
      activeRequestIdRef.current = requestId;
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const isStaleRequest = () => activeRequestIdRef.current !== requestId;

      let activeSessionId = sessionId;
      if (!activeSessionId) {
        try {
          const task = await createTask();
          activeSessionId = task.session_id;
          setSessionId(activeSessionId);
          setStoredCurrentSessionId(undefined, activeSessionId);
        } catch (err) {
          if (err instanceof AuthError) {
            clearApiKey();
            setAuthState("needs_auth");
            clearStoredCurrentSessionId();
          }
          return;
        }
      }

      const sentAt = new Date().toISOString();
      const displayText = describeChatFilesForDisplay(text, filesForSend);
      const userMessageId = Date.now();
      const assistantMessageId = `${userMessageId}-assistant`;
      setMessages((prev) => [
        ...prev,
        { id: userMessageId, role: "user", content: displayText, created_at: sentAt },
        { id: assistantMessageId, role: "assistant", content: "", toolCalls: [] },
      ]);
      setInput("");
      setPendingFiles([]);
      setIsGenerating(true);

      let currentContent = "";
      const assistantUpdates = new Map<string, string>();
      const upsertAssistantUpdate = (id: string, content: string) => {
        setMessages((prev) => {
          const updateId = `assistant-update-${id}`;
          const existingIndex = prev.findIndex((message) => message.id === updateId);
          if (existingIndex >= 0) {
            return prev.map((message, index) =>
              index === existingIndex ? { ...message, content } : message
            );
          }

          const updateMessage: Message = {
            id: updateId,
            role: "assistant",
            content,
            created_at: new Date().toISOString(),
          };
          const placeholderIndex = prev.findIndex((message) => message.id === assistantMessageId);
          if (placeholderIndex < 0) {
            return [...prev, updateMessage];
          }
          return [
            ...prev.slice(0, placeholderIndex),
            updateMessage,
            ...prev.slice(placeholderIndex),
          ];
        });
      };

      await sendChatMessage(
        activeSessionId,
        text,
        selectedModel,
        {
          onMessageDelta: (delta) => {
            if (isStaleRequest()) return;
            currentContent += delta;
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") last.content = currentContent;
              return msgs;
            });
          },
          onAssistantUpdateDelta: (id, delta) => {
            if (isStaleRequest()) return;
            const next = (assistantUpdates.get(id) || "") + delta;
            assistantUpdates.set(id, next);
            upsertAssistantUpdate(id, next);
          },
          onAssistantUpdate: (id, content) => {
            if (isStaleRequest()) return;
            assistantUpdates.set(id, content);
            upsertAssistantUpdate(id, content);
          },
          onToolCall: (toolCall) => {
            if (isStaleRequest()) return;
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") {
                const idx = last.toolCalls?.findIndex((t) => t.id === toolCall.id) ?? -1;
                if (idx >= 0 && last.toolCalls) {
                  last.toolCalls[idx] = toolCall;
                } else {
                  last.toolCalls = [...(last.toolCalls || []), toolCall];
                }
                if (toolCall.name === "AskUser") {
                  try {
                    const args =
                      typeof toolCall.arguments === "string"
                        ? JSON.parse(toolCall.arguments)
                        : toolCall.arguments;
                    if (args?.question) {
                      last.askUser = { question: args.question, options: args.options || [] };
                    }
                  } catch {
                    /* ignore parse error */
                  }
                }
              }
              return msgs;
            });
          },
          onNewTurn: () => {
            if (isStaleRequest()) return;
            currentContent = "";
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now() + Math.random(),
                role: "assistant",
                content: "",
                toolCalls: [],
              },
            ]);
          },
          onToolResult: (toolId, result) => {
            if (isStaleRequest()) return;
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") {
                const tc = last.toolCalls?.find((t) => t.id === toolId);
                if (tc) {
                  tc.status = "success";
                  tc.result = result;
                }
              }
              return msgs;
            });
          },
          onTaskCreated: (task) => {
            if (isStaleRequest()) return;
            setTaskSteps((prev) => upsertTask(prev, task));
          },
          onTaskUpdated: (task) => {
            if (isStaleRequest()) return;
            setTaskSteps((prev) => applyTaskUpdate(prev, task));
          },
          onTaskProgress: (progress) => {
            if (isStaleRequest()) return;
            setTaskProgress(progress);
          },
          onTaskPlanUpdated: (update) => {
            if (isStaleRequest()) return;
            const next = applyTaskPlanUpdate([], update);
            setTaskSteps(next.taskSteps);
            setTaskProgress(next.taskProgress);
          },
          onRuntimeEvent: (event) => {
            if (isStaleRequest()) return;
            const createdAt = new Date().toISOString();
            setRuntimeTimelineEvents((prev) => [
              ...prev,
              codexRuntimeEventToTimelineEvent(event, {
                id: `runtime-${requestId}-${prev.length}`,
                createdAt,
              }),
            ]);
          },
          onAgentStop: (data) => {
            if (isStaleRequest()) return;
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role !== "assistant") return msgs;

              if (data.stop_reason === "ask_user" && typeof data.metadata.question === "string") {
                last.askUser = {
                  question: data.metadata.question,
                  options: Array.isArray(data.metadata.options)
                    ? data.metadata.options.filter(
                        (option): option is string => typeof option === "string"
                      )
                    : [],
                };
              }

              if (data.stop_reason === "permission_request") {
                last.permissionRequest = {
                  tool: typeof data.metadata.tool === "string" ? data.metadata.tool : "unknown",
                  params:
                    typeof data.metadata.params === "string" ||
                    (data.metadata.params && typeof data.metadata.params === "object")
                      ? (data.metadata.params as Record<string, unknown> | string)
                      : {},
                  riskLevel:
                    typeof data.metadata.riskLevel === "string"
                      ? data.metadata.riskLevel
                      : "dangerous",
                };
              }

              return msgs;
            });
          },
          onPermissionRequest: (request) => {
            if (isStaleRequest()) return;
            setIsGenerating(false);
            setInputFocusToken((prev) => bumpInputFocusToken(prev));
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") last.permissionRequest = request;
              return msgs;
            });
          },
          onUsage: (usage) => {
            if (isStaleRequest()) return;
            setTokenUsage((prev) => ({
              prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
              completion_tokens: prev.completion_tokens + usage.completion_tokens,
              total_tokens: prev.total_tokens + usage.total_tokens,
            }));
            const ctx = usage.last_prompt_tokens ?? usage.prompt_tokens;
            if (ctx > 0) setLastContextTokens(ctx);
          },
          onComplete: () => {
            if (isStaleRequest()) return;
            abortControllerRef.current = null;
            setIsGenerating(false);
            const nextPlan = clearTaskPlanState();
            setTaskSteps(nextPlan.taskSteps);
            setTaskProgress(nextPlan.taskProgress);
            setInputFocusToken((prev) => bumpInputFocusToken(prev));
            loadSessions();
            setWorkspaceRefreshToken((prev) => prev + 1);
          },
          onError: (err) => {
            if (isStaleRequest()) return;
            abortControllerRef.current = null;
            if (err instanceof AuthError) {
              clearApiKey();
              setAuthState("needs_auth");
              setAuthErrorMsg("API Key 已失效");
              clearStoredCurrentSessionId();
              setIsGenerating(false);
              setInputFocusToken((prev) => bumpInputFocusToken(prev));
              return;
            }
            console.error("Chat error:", err);
            setIsGenerating(false);
            setInputFocusToken((prev) => bumpInputFocusToken(prev));
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant" && !last.content) {
                last.content = "无法连接到 Ripple 服务。请确认服务端正在运行。";
              }
              return msgs;
            });
          },
        },
        { signal: abortController.signal, files: filesForSend }
      );
    },
    [handleClearContext, input, isGenerating, loadSessions, pendingFiles, selectedModel, sessionId]
  );

  const handleQuickReply = useCallback(
    (option: string) => {
      setInput(option);
      handleSendMessage(option);
    },
    [handleSendMessage]
  );

  const handleCopySessionId = useCallback(async () => {
    if (!sessionId) return;
    const ok = await copyTextToClipboard(sessionId);
    if (!ok) return;
    setSessionIdCopied(true);
    window.setTimeout(() => setSessionIdCopied(false), 1600);
  }, [sessionId]);

  const handleSelectView = useCallback((view: WorkspaceView) => {
    setActiveView(view);
    setIsSidebarOpen(false);
  }, []);

  const handlePermissionResolve = useCallback(
    async (action: "allow" | "always" | "deny") => {
      if (!sessionId || isGenerating) return;

      try {
        const ok = await resolveTaskPermissionRequest(sessionId, action);
        if (!ok) {
          throw new Error("Failed to resolve permission request");
        }

        const text =
          action === "deny"
            ? "Denied."
            : action === "always"
              ? "Approved for this session. Please proceed."
              : "Approved. Please proceed.";
        setInput(text);
        await handleSendMessage(text);
      } catch (err) {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState("needs_auth");
          setAuthErrorMsg("API Key 已失效");
          clearStoredCurrentSessionId();
          return;
        }

        console.error("Permission resolve error:", err);
      }
    },
    [handleSendMessage, isGenerating, sessionId]
  );

  const pendingInteractionMessage = useMemo(
    () => [...messages].reverse().find((message) => message.permissionRequest || message.askUser),
    [messages]
  );
  const pendingPermission = pendingInteractionMessage?.permissionRequest || null;
  const currentSessionRuntimeStatus = isGenerating
    ? ("running" as const)
    : pendingInteractionMessage?.permissionRequest
      ? ("waiting_for_approval" as const)
      : pendingInteractionMessage?.askUser
        ? ("waiting_for_user" as const)
        : null;

  const workbenchSessions = useMemo(
    () =>
      applyCurrentSessionRuntimeStatus(
        createWorkbenchSessionsFromTaskSummaries(sessionSummaries),
        sessionId,
        currentSessionRuntimeStatus
      ),
    [currentSessionRuntimeStatus, sessionId, sessionSummaries]
  );
  const selectedExistingSession = sessionId
    ? workbenchSessions.find((session) => session.sessionId === sessionId) || null
    : null;
  const inferredCurrentSession =
    sessionId && !selectedExistingSession
      ? {
          sessionId,
          title: "Current Codex session",
          status: currentSessionRuntimeStatus || ("idle" as const),
          model: selectedModel,
          lastActivityAt: new Date().toISOString(),
          messageCount: messages.length,
          changedFileCount: 0,
          pendingApprovalCount: 0,
        }
      : null;
  const selectedWorkbenchSession = selectedExistingSession || inferredCurrentSession;
  const displayWorkbenchSessions =
    inferredCurrentSession &&
    !workbenchSessions.some((session) => session.sessionId === inferredCurrentSession.sessionId)
      ? [inferredCurrentSession, ...workbenchSessions]
      : workbenchSessions;
  const timelineEvents = useMemo(
    () => [...messagesToTimelineEvents(messages), ...runtimeTimelineEvents],
    [messages, runtimeTimelineEvents]
  );
  const changedFiles = useMemo(() => extractChangedFilePaths(messages), [messages]);
  const mainContent =
    activeView === "home" ? (
      <HomePage
        userId={userId}
        sessions={displayWorkbenchSessions}
        isLoadingSessions={isLoadingSessions}
        onNewSession={handleNewSession}
        onSelectSession={(selectedSessionId) => void handleSwitchSession(selectedSessionId)}
        onSelectView={handleSelectView}
      />
    ) : activeView === "files" ? (
      <FilesPage userId={userId} refreshToken={workspaceRefreshToken} />
    ) : activeView === "connectors" ? (
      <ConnectorsPage />
    ) : (
      <TaskPage
        session={selectedWorkbenchSession}
        messages={messages}
        timelineEvents={timelineEvents}
        taskProgress={taskProgress}
        taskSteps={taskSteps}
        tokenUsage={tokenUsage}
        lastContextTokens={lastContextTokens}
        input={input}
        pendingFiles={pendingFiles}
        isGenerating={isGenerating}
        focusToken={inputFocusToken}
        selectedModel={selectedModel}
        models={models}
        isModelDropdownOpen={openModelDropdown === "composer"}
        sessionId={sessionId}
        sessionIdCopied={sessionIdCopied}
        onInputChange={setInput}
        onClearContext={handleClearContext}
        onAttachFiles={handleAttachFiles}
        onRemovePendingFile={handleRemovePendingFile}
        onToggleModelDropdown={() =>
          setOpenModelDropdown((open) => (open === "composer" ? null : "composer"))
        }
        onSelectModel={(model) => {
          setSelectedModel(model);
          setOpenModelDropdown(null);
        }}
        onCopySessionId={handleCopySessionId}
        onSend={handleSendMessage}
        onStop={handleStop}
        onQuickReply={handleQuickReply}
        onPermissionResolve={handlePermissionResolve}
      />
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
                  Enter your API key to continue
                </p>
                <p className="mt-1 text-center font-[family-name:var(--font-cjk)] text-sm text-[#687280]">
                  请输入 API Key 以访问服务
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
        nav={
          <WorkspaceNav
            sessions={displayWorkbenchSessions}
            selectedSessionId={sessionId}
            activeView={activeView}
            isLoading={isLoadingSessions}
            isGenerating={isGenerating}
            userId={userId}
            onNewSession={handleNewSession}
            onSelectView={handleSelectView}
            onSelectSession={(selectedSessionId) => {
              void handleSwitchSession(selectedSessionId);
              setIsSidebarOpen(false);
            }}
            onDeleteSession={handleDeleteSession}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        }
        content={mainContent}
        inspector={
          shouldShowInspector(activeView) ? (
            <InspectorPanel
              userId={userId}
              refreshToken={workspaceRefreshToken}
              events={timelineEvents}
              changedFiles={changedFiles}
              pendingPermission={pendingPermission}
              onPermissionResolve={handlePermissionResolve}
            />
          ) : null
        }
        mobileNav={
          <MobileTabBar
            activeView={activeView}
            onSelectView={handleSelectView}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        }
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
          setIsSettingsOpen(false);
          setAuthState("needs_auth");
        }}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function mapBackendMessages(
  details: TaskDetail | { messages: Record<string, unknown>[] }
): Message[] {
  const result: Message[] = [];
  let id = Date.now();
  const raw = details.messages;
  const pendingQuestion = "pending_question" in details ? details.pending_question : null;
  const pendingOptions = "pending_options" in details ? details.pending_options : null;
  const pendingPermissionRequest =
    "pending_permission_request" in details ? details.pending_permission_request : null;

  for (const msg of raw) {
    const internalType = typeof msg.type === "string" ? msg.type : null;
    const role = typeof msg.role === "string" ? msg.role : null;

    if (internalType === "user") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      const content = getInternalMessageContent(msg);
      const textContent = extractText(content);
      if (textContent) {
        result.push({ id: id++, role: "user", content: textContent, created_at: createdAt });
      }

      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;

        for (let i = result.length - 1; i >= 0; i--) {
          const message = result[i];
          if (message.role !== "assistant" || !message.toolCalls) continue;

          const toolCall = message.toolCalls.find((tool) => tool.id === block.tool_use_id);
          if (toolCall) {
            toolCall.result =
              typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            toolCall.status = block.is_error ? "error" : "success";
            break;
          }
        }
      }
      continue;
    }

    if (internalType === "assistant") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      const content = getInternalMessageContent(msg);
      const toolCalls = content
        .filter(
          (block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_use"
        )
        .map((block) => ({
          id: typeof block.id === "string" ? block.id : `tool-${id}`,
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: isRecord(block.input) ? block.input : {},
          status: "success" as const,
          result: "",
        }));
      const assistantMessage: Message = {
        id: id++,
        role: "assistant",
        content: extractText(content),
        created_at: createdAt,
        toolCalls,
      };

      const askUserTool = content.find(
        (block) => isRecord(block) && block.type === "tool_use" && block.name === "AskUser"
      );
      if (
        isRecord(askUserTool) &&
        isRecord(askUserTool.input) &&
        typeof askUserTool.input.question === "string"
      ) {
        assistantMessage.askUser = {
          question: askUserTool.input.question,
          options: Array.isArray(askUserTool.input.options)
            ? askUserTool.input.options.filter(
                (option): option is string => typeof option === "string"
              )
            : [],
        };
      }

      result.push(assistantMessage);
      continue;
    }

    if (role === "user") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      result.push({
        id: id++,
        role: "user",
        content: extractText(msg.content),
        created_at: createdAt,
      });
    } else if (role === "assistant") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      const toolCalls =
        (
          msg.tool_calls as
            | Array<{
                id: string;
                function?: { name: string; arguments: string | Record<string, unknown> };
              }>
            | undefined
        )?.map((tc) => ({
          id: tc.id,
          name: tc.function?.name || "unknown",
          arguments: tc.function?.arguments || {},
          status: "success" as const,
          result: "",
        })) || [];
      const assistantMessage: Message = {
        id: id++,
        role: "assistant",
        content: extractText(msg.content),
        created_at: createdAt,
        toolCalls,
      };
      result.push(assistantMessage);
    } else if (role === "tool") {
      for (let i = result.length - 1; i >= 0; i--) {
        const m = result[i];
        if (m.role === "assistant" && m.toolCalls) {
          const tc = m.toolCalls.find((t) => t.id === (msg.tool_call_id as string));
          if (tc) {
            tc.result = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            break;
          }
        }
      }
    }
  }

  if (pendingQuestion) {
    const lastAssistant = [...result].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) {
      lastAssistant.askUser = {
        question: pendingQuestion,
        options: Array.isArray(pendingOptions) ? pendingOptions : [],
      };
    }
  }

  if (pendingPermissionRequest) {
    const lastAssistant = [...result].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) {
      lastAssistant.permissionRequest = pendingPermissionRequest;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getInternalMessageContent(message: Record<string, unknown>): Record<string, unknown>[] {
  if (!isRecord(message.message)) return [];
  const content = message.message.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text || "")
          .join("\n");
      }
    } catch {
      /* not JSON, use as-is */
    }
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const fileParts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
        continue;
      }
      if (
        (item.type === "file" || item.type === "attachment" || item.type === "localImage") &&
        isRecord(item.file)
      ) {
        const name = typeof item.file.name === "string" ? item.file.name : "file";
        const path = typeof item.file.path === "string" ? item.file.path : "";
        fileParts.push(path ? `- ${name} (${path})` : `- ${name}`);
        continue;
      }
      if (item.type === "attachment" || item.type === "localImage") {
        const name = typeof item.name === "string" ? item.name : "file";
        const path = typeof item.path === "string" ? item.path : "";
        fileParts.push(path ? `- ${name} (${path})` : `- ${name}`);
      }
    }
    return [
      textParts.join("\n"),
      fileParts.length ? `Attached files:\n${fileParts.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return content ? JSON.stringify(content) : "";
}
