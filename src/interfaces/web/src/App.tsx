import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AlertTriangle, KeyRound } from "lucide-react";
import { Message, UsageInfo, Session, SessionDetail, TaskInfo, TaskProgress } from "@/types";
import {
  createSession,
  sendChatMessage,
  stopSession,
  fetchModels,
  getApiKey,
  setApiKey,
  clearApiKey,
  getUserId,
  setUserId,
  AuthError,
  fetchSessions,
  fetchSessionDetails,
  deleteSession,
  resolvePermissionRequest,
} from "@/lib/api";
import RippleIcon from "@/components/icons/RippleIcon";
import SettingsModal from "@/components/SettingsModal";
import InspectorPanel from "@/components/workbench/InspectorPanel";
import MobileTabBar from "@/components/workbench/MobileTabBar";
import TaskPage from "@/components/workbench/TaskPage";
import WorkbenchShell from "@/components/workbench/WorkbenchShell";
import WorkbenchTopBar from "@/components/workbench/WorkbenchTopBar";
import WorkspaceNav from "@/components/workbench/WorkspaceNav";
import { applyTaskUpdate, upsertTask } from "@/lib/chatState";
import { copyTextToClipboard } from "@/lib/clipboard";
import { bumpInputFocusToken } from "@/lib/inputFocus";
import {
  clearStoredCurrentSessionId,
  getStoredCurrentSessionId,
  pickRestorableSessionId,
  setStoredCurrentSessionId,
} from "@/lib/sessionPersistence";
import {
  createWorkbenchTasks,
  extractChangedFilePaths,
  messagesToTimelineEvents,
} from "@/lib/workbench";

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
  const [isGenerating, setIsGenerating] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  // ── Model state ──
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState("codex-medium");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);

  // ── User identity ──
  const [userId, setUserIdState] = useState<string>(() => getUserId());

  // ── UI state ──
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);

  // ── Token tracking ──
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  const [lastContextTokens, setLastContextTokens] = useState(0);

  // ── Task tracking ──
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);

  const activeRequestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ── Load sessions ──
  const loadSessions = useCallback(async (): Promise<Session[]> => {
    if (authState !== "authenticated") return [];
    try {
      setIsLoadingSessions(true);
      const loadedSessions = await fetchSessions();
      setSessions(loadedSessions);
      return loadedSessions;
    } catch {
      return [];
    } finally {
      setIsLoadingSessions(false);
    }
  }, [authState]);

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
      setSessions([]);
      setTasks([]);
      setTaskProgress(null);
      setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      setLastContextTokens(0);
      setIsGenerating(false);
      clearStoredCurrentSessionId();
      if (authState === "authenticated") {
        const loaded = await loadSessions();
        console.info(`[ripple] switched to user "${newUid}", loaded ${loaded.length} sessions`);
      }
    },
    [authState, loadSessions]
  );

  const applySessionDetails = useCallback((details: SessionDetail) => {
    setSessionId(details.session_id);
    setSelectedModel(details.model);
    setMessages(mapBackendMessages(details));
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setLastContextTokens(0);
    setTasks([]);
    setTaskProgress(null);
    setStoredCurrentSessionId(undefined, details.session_id);
  }, []);

  const restoreStoredSession = useCallback(
    async (availableSessions: Session[]) => {
      const storedSessionId = getStoredCurrentSessionId();
      const restorableSessionId = pickRestorableSessionId(storedSessionId, availableSessions);

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
  const handleSwitchSession = async (id: string) => {
    if (id === sessionId || isGenerating) return;
    try {
      const details = await fetchSessionDetails(id);
      if (!details) return;
      applySessionDetails(details);
      setIsSidebarOpen(false);
    } catch (err) {
      console.error("Error switching session:", err);
    }
  };

  // ── New chat ──
  const handleNewChat = async () => {
    if (isGenerating) return;
    setMessages([]);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setLastContextTokens(0);
    setTasks([]);
    setTaskProgress(null);
    try {
      const id = await createSession();
      setSessionId(id);
      setStoredCurrentSessionId(undefined, id);
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
  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isGenerating) return;
    if (await deleteSession(id)) {
      setSessions((prev) => prev.filter((s) => s.session_id !== id));
      if (getStoredCurrentSessionId() === id) {
        clearStoredCurrentSessionId();
      }
      if (id === sessionId) {
        setSessionId(null);
        setMessages([]);
        setTasks([]);
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
      await stopSession(sessionId);
    }
    setIsGenerating(false);
    setInputFocusToken((prev) => bumpInputFocusToken(prev));
  }, [sessionId]);

  // ── Send message ──
  const handleSendMessage = useCallback(
    async (overrideText?: string) => {
      const text = typeof overrideText === "string" ? overrideText.trim() : input.trim();
      if (!text || isGenerating) return;
      const requestId = activeRequestIdRef.current + 1;
      activeRequestIdRef.current = requestId;
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const isStaleRequest = () => activeRequestIdRef.current !== requestId;

      let activeSessionId = sessionId;
      if (!activeSessionId) {
        try {
          activeSessionId = await createSession();
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
      setMessages((prev) => [
        ...prev,
        { id: Date.now(), role: "user", content: text, created_at: sentAt },
        { id: Date.now() + 1, role: "assistant", content: "", toolCalls: [] },
      ]);
      setInput("");
      setIsGenerating(true);

      let currentContent = "";

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
            setTasks((prev) => upsertTask(prev, task));
          },
          onTaskUpdated: (task) => {
            if (isStaleRequest()) return;
            setTasks((prev) => applyTaskUpdate(prev, task));
          },
          onTaskProgress: (progress) => {
            if (isStaleRequest()) return;
            setTaskProgress(progress);
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
        { signal: abortController.signal }
      );
    },
    [input, isGenerating, sessionId, selectedModel, loadSessions]
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

  const handlePermissionResolve = useCallback(
    async (action: "allow" | "always" | "deny") => {
      if (!sessionId || isGenerating) return;

      try {
        const ok = await resolvePermissionRequest(sessionId, action);
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

  const workbenchTasks = useMemo(() => createWorkbenchTasks(sessions), [sessions]);
  const selectedExistingTask = sessionId
    ? workbenchTasks.find((task) => task.id === sessionId) || null
    : null;
  const inferredCurrentTask =
    sessionId && !selectedExistingTask
      ? {
          id: sessionId,
          title: "Current Codex task",
          status: isGenerating ? ("running" as const) : ("idle" as const),
          model: selectedModel,
          lastActivityAt: new Date().toISOString(),
          messageCount: messages.length,
          changedFileCount: 0,
          pendingApprovalCount: 0,
        }
      : null;
  const selectedWorkbenchTask = selectedExistingTask || inferredCurrentTask;
  const displayWorkbenchTasks =
    inferredCurrentTask && !workbenchTasks.some((task) => task.id === inferredCurrentTask.id)
      ? [inferredCurrentTask, ...workbenchTasks]
      : workbenchTasks;
  const timelineEvents = useMemo(() => messagesToTimelineEvents(messages), [messages]);
  const pendingApprovalCount = messages.some((message) => Boolean(message.permissionRequest))
    ? 1
    : selectedWorkbenchTask?.pendingApprovalCount || 0;
  const pendingPermission =
    [...messages].reverse().find((message) => message.permissionRequest)?.permissionRequest || null;
  const changedFiles = useMemo(() => extractChangedFilePaths(messages), [messages]);
  const workbenchStatus =
    pendingApprovalCount > 0
      ? "waiting_for_approval"
      : isGenerating
        ? "running"
        : selectedWorkbenchTask?.status || "idle";
  const isContextWarning = lastContextTokens > 150_000;

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
        topBar={
          <WorkbenchTopBar
            taskTitle={selectedWorkbenchTask?.title || "Ripple"}
            userId={userId}
            selectedModel={selectedModel}
            models={models}
            isModelDropdownOpen={isModelDropdownOpen}
            onToggleModelDropdown={() => setIsModelDropdownOpen((open) => !open)}
            onSelectModel={(model) => {
              setSelectedModel(model);
              setIsModelDropdownOpen(false);
            }}
            status={workbenchStatus}
            tokenUsage={tokenUsage}
            isContextWarning={isContextWarning}
            sessionId={sessionId}
            sessionIdCopied={sessionIdCopied}
            pendingApprovalCount={pendingApprovalCount}
            onCopySessionId={handleCopySessionId}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenNav={() => setIsSidebarOpen(true)}
          />
        }
        nav={
          <WorkspaceNav
            tasks={displayWorkbenchTasks}
            selectedTaskId={sessionId}
            isLoading={isLoadingSessions}
            isGenerating={isGenerating}
            userId={userId}
            onNewTask={handleNewChat}
            onSelectTask={(id) => {
              void handleSwitchSession(id);
              setIsSidebarOpen(false);
            }}
            onDeleteTask={handleDeleteSession}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        }
        content={
          <TaskPage
            task={selectedWorkbenchTask}
            messages={messages}
            timelineEvents={timelineEvents}
            taskProgress={taskProgress}
            taskSteps={tasks}
            tokenUsage={tokenUsage}
            lastContextTokens={lastContextTokens}
            input={input}
            isGenerating={isGenerating}
            focusToken={inputFocusToken}
            onInputChange={setInput}
            onSend={handleSendMessage}
            onStop={handleStop}
            onQuickReply={handleQuickReply}
            onPermissionResolve={handlePermissionResolve}
          />
        }
        inspector={
          <InspectorPanel
            userId={userId}
            refreshToken={workspaceRefreshToken}
            events={timelineEvents}
            changedFiles={changedFiles}
            pendingPermission={pendingPermission}
            onPermissionResolve={handlePermissionResolve}
          />
        }
        mobileNav={
          <MobileTabBar
            onOpenNav={() => setIsSidebarOpen(true)}
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
  details: SessionDetail | { messages: Record<string, unknown>[] }
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
    return (content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}
