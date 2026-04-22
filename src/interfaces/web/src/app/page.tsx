"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Cpu,
  ChevronDown,
  Brain,
  AlertTriangle,
  KeyRound,
  Menu,
  Copy,
  Check,
  UserRound,
} from "lucide-react";
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
import Sidebar from "@/components/Sidebar";
import ChatInput from "@/components/ChatInput";
import ChatMessage from "@/components/ChatMessage";
import TaskExecutionPanel from "@/components/TaskExecutionPanel";
import SettingsModal from "@/components/SettingsModal";
import { applyTaskUpdate, upsertTask } from "@/lib/chatState";
import { copyTextToClipboard } from "@/lib/clipboard";
import { bumpInputFocusToken } from "@/lib/inputFocus";
import {
  clearStoredCurrentSessionId,
  getStoredCurrentSessionId,
  pickRestorableSessionId,
  setStoredCurrentSessionId,
} from "@/lib/sessionPersistence";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function Home() {
  // ── Auth state ──
  const [authState, setAuthState] = useState<"checking" | "needs_auth" | "authenticated">(
    "checking"
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
  const [selectedModel, setSelectedModel] = useState("sonnet");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);

  // ── User identity ──
  const [userId, setUserIdState] = useState<string>(() => getUserId());

  // ── UI state ──
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);

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

  // ── Resizable right panel ──
  const [rightPanelWidth, setRightPanelWidth] = useState(820);
  const isResizingRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeRequestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ── Scroll to bottom on new messages ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Auth check ──
  useEffect(() => {
    setAuthState(getApiKey() ? "authenticated" : "needs_auth");
  }, []);

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
          setSelectedModel(fetched.find((m) => m.id === "sonnet")?.id || fetched[0].id);
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

      setMessages((prev) => [
        ...prev,
        { id: Date.now(), role: "user", content: text },
        { id: Date.now() + 1, role: "assistant", content: "", toolCalls: [] },
      ]);
      setInput("");
      setIsGenerating(true);

      let currentContent = "";

      await sendChatMessage(
        activeSessionId,
        text,
        selectedModel,
        thinkingEnabled,
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
              { id: Date.now() + Math.random(), role: "assistant", content: "", toolCalls: [] },
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
    [input, isGenerating, sessionId, selectedModel, thinkingEnabled, loadSessions]
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

  // ── Resize right panel ──
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = rightPanelWidth;
      const onMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return;
        setRightPanelWidth(Math.min(1200, Math.max(300, startWidth + startX - ev.clientX)));
      };
      const onUp = () => {
        isResizingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [rightPanelWidth]
  );

  // ── Collect tool calls for execution panel ──
  const allToolCalls = messages.flatMap((m) =>
    m.role === "assistant" && m.toolCalls ? m.toolCalls : []
  );
  const showMobileTaskPanel = tasks.length > 0 || allToolCalls.length > 0;

  const isContextWarning = lastContextTokens > 150_000;

  // ═══════════════════════════════════════════════════════
  // AUTH SCREEN
  // ═══════════════════════════════════════════════════════
  if (authState !== "authenticated") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black">
        {authState === "needs_auth" && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-4 w-full max-w-sm"
          >
            <div className="surface-panel rounded-2xl p-8">
              <div className="mb-8 flex flex-col items-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-black/5">
                  <RippleIcon size={28} className="text-[#ededed]" />
                </div>
                <h1 className="text-xl font-semibold text-[#ededed]">RIPPLE</h1>
                <p className="mt-3 text-center text-sm text-[#888888]">
                  Enter your API key to continue
                </p>
                <p className="mt-1 text-center font-[family-name:var(--font-cjk)] text-sm text-[#666666]">
                  请输入 API Key 以访问服务
                </p>
              </div>
              {authErrorMsg && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#ff4444]/20 bg-[#ff4444]/10 p-3 text-sm text-[#ff4444]">
                  <AlertTriangle size={16} />
                  <span>{authErrorMsg}</span>
                </div>
              )}
              <form onSubmit={handleAuthSubmit}>
                <div className="relative mb-4">
                  <KeyRound
                    size={18}
                    className="absolute top-1/2 left-4 -translate-y-1/2 text-[#666666]"
                  />
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="Enter API key..."
                    className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] py-3 pr-4 pl-11 font-[family-name:var(--font-mono)] text-sm text-[#ededed] placeholder:text-[#666666] focus:border-[#ededed]/50 focus:ring-2 focus:ring-[#10b981]/15 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!keyInput.trim()}
                  className="btn-primary w-full py-3 text-sm"
                >
                  Connect
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // MAIN APP
  // ═══════════════════════════════════════════════════════
  return (
    <div className="h-screen w-screen overflow-hidden bg-black">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="flex h-full w-full"
      >
        {/* Sidebar */}
        <Sidebar
          sessions={sessions}
          currentSessionId={sessionId}
          isLoadingSessions={isLoadingSessions}
          isGenerating={isGenerating}
          tokenUsage={tokenUsage}
          lastContextTokens={lastContextTokens}
          isMobileOpen={isSidebarOpen}
          userId={userId}
          onNewChat={handleNewChat}
          onSwitchSession={handleSwitchSession}
          onDeleteSession={handleDeleteSession}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onCloseMobile={() => setIsSidebarOpen(false)}
        />

        {/* Main chat area */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="surface-panel z-20 flex h-14 items-center justify-between rounded-none border-t-0 border-r-0 border-b border-l-0 px-4 md:px-6">
            <div className="flex items-center gap-2">
              {/* Mobile menu */}
              <button
                onClick={() => setIsSidebarOpen(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[#888888] hover:bg-white/5 hover:text-[#ededed] md:hidden"
              >
                <Menu size={18} />
              </button>

              {/* Model selector */}
              <div className="relative">
                <button
                  onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0a0a0a] px-2.5 py-1.5 text-sm text-[#ededed] transition-colors hover:border-white/20"
                >
                  <Cpu size={14} className="text-[#ededed]" />
                  <span className="font-[family-name:var(--font-mono)] text-sm font-medium">
                    {selectedModel}
                  </span>
                  <ChevronDown
                    size={12}
                    className={`text-[#666666] transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>
                <AnimatePresence>
                  {isModelDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 4 }}
                      transition={{ duration: 0.1 }}
                      className="absolute top-full left-0 z-50 mt-1 w-44 overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0a] shadow-lg"
                    >
                      <div className="p-1">
                        {models.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => {
                              setSelectedModel(m.id);
                              setIsModelDropdownOpen(false);
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-[family-name:var(--font-mono)] text-sm transition-colors ${
                              selectedModel === m.id
                                ? "bg-[#ededed]/10 font-medium text-[#ededed]"
                                : "text-[#888888] hover:bg-[#0a0a0a] hover:text-[#ededed]"
                            }`}
                          >
                            {m.id}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {thinkingEnabled && (
                <div className="flex items-center gap-1 rounded-md border border-white/10 bg-black/5 px-2 py-1 text-[#ededed]">
                  <Brain size={11} />
                  <span className="text-xs font-medium">Think</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {tokenUsage.total_tokens > 0 && (
                <div
                  className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 font-[family-name:var(--font-mono)] text-xs sm:flex ${
                    isContextWarning
                      ? "border-[#ff4444]/20 bg-[#ff4444]/10 text-[#ff4444]"
                      : "border-white/10 bg-[#0a0a0a] text-[#888888]"
                  }`}
                >
                  {isContextWarning && <AlertTriangle size={11} />}
                  <span className="text-[#ededed]">↑{formatTokens(tokenUsage.prompt_tokens)}</span>
                  <span className="text-[#666666]">|</span>
                  <span className="text-[#ededed]">
                    ↓{formatTokens(tokenUsage.completion_tokens)}
                  </span>
                </div>
              )}
              {sessionId && (
                <button
                  type="button"
                  onClick={handleCopySessionId}
                  title={sessionIdCopied ? "已复制" : `点击复制 Session ID: ${sessionId}`}
                  className="hidden items-center gap-1.5 rounded-lg border border-white/10 bg-[#0a0a0a] px-2.5 py-1 font-[family-name:var(--font-mono)] text-xs text-[#888888] transition-colors hover:border-[#ededed]/40 hover:text-[#ededed] sm:flex"
                >
                  <span className="text-[#666666]">ID</span>
                  <span className="max-w-[140px] truncate">{sessionId}</span>
                  {sessionIdCopied ? (
                    <Check size={12} className="text-[#ededed]" />
                  ) : (
                    <Copy size={12} className="text-[#666666]" />
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                title="Click to change user in Settings"
                className={`group hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 font-[family-name:var(--font-mono)] text-xs transition-all duration-300 sm:flex ${
                  userId === "default"
                    ? "border-[#ff9d2a]/30 bg-gradient-to-r from-[#ff9d2a]/10 to-transparent text-[#ff9d2a] hover:border-[#ff9d2a]/60 hover:shadow-[0_0_10px_rgba(255,157,42,0.1)]"
                    : "border-white/20 bg-gradient-to-r from-white/5 to-transparent text-[#ededed] hover:border-white/40 hover:shadow-[0_0_10px_rgba(255,255,255,0.05)]"
                }`}
              >
                <UserRound size={12} className="transition-transform duration-300 group-hover:scale-110" />
                <span className="max-w-[120px] truncate font-semibold">{userId}</span>
              </button>
              <div
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
                  sessionId
                    ? "border-white/10 bg-black/5 text-[#ededed]"
                    : "border-white/10 bg-[#0a0a0a] text-[#666666]"
                }`}
              >
                <div
                  className={`h-2 w-2 rounded-full ${sessionId ? "glow-white bg-transparent" : "bg-[#71717a]"}`}
                  style={
                    sessionId ? { animation: "glow-pulse 2s ease-in-out infinite" } : undefined
                  }
                />
                <span className="text-xs font-medium">{sessionId ? "Online" : "Ready"}</span>
              </div>
            </div>
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 pt-6 pb-4 md:px-6">
            <div className="mx-auto max-w-5xl space-y-3">
              {messages.length === 0 && (
                <div className="flex h-[50vh] flex-col items-center justify-center text-[#666666]">
                  <div
                    className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-black/5"
                    style={{ animation: "float-breathe 3s ease-in-out infinite" }}
                  >
                    <RippleIcon size={40} className="text-white/50" />
                  </div>
                  <p className="text-lg font-semibold text-[#ededed]">Ripple</p>
                  <p className="mt-2 text-sm text-[#888888]">Start a conversation</p>
                  <p className="mt-1 font-[family-name:var(--font-cjk)] text-sm text-[#666666]">
                    输入消息开始对话
                  </p>
                </div>
              )}
              <AnimatePresence initial={false}>
                {messages.map((msg, i) => (
                  <ChatMessage
                    key={msg.id}
                    msg={msg}
                    isGenerating={isGenerating}
                    isLast={i === messages.length - 1}
                    onQuickReply={handleQuickReply}
                    onPermissionResolve={handlePermissionResolve}
                  />
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          {showMobileTaskPanel && (
            <div className="surface-panel mx-4 mb-3 max-h-72 overflow-hidden rounded-xl md:mx-6 lg:hidden">
              <TaskExecutionPanel
                tasks={tasks}
                taskProgress={taskProgress}
                toolCalls={allToolCalls}
                isGenerating={isGenerating}
              />
            </div>
          )}

          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSendMessage}
            onStop={handleStop}
            isGenerating={isGenerating}
            hasSession={!!sessionId}
            focusToken={inputFocusToken}
          />
        </main>

        {/* Resize handle */}
        <div
          className="z-30 hidden w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-black transition-colors hover:bg-[#ededed]/15 lg:flex"
          onMouseDown={handleResizeStart}
        >
          <div className="h-12 w-0.5 rounded-full bg-[#27272a]" />
        </div>

        {/* Right panel */}
        <aside
          className="surface-panel hidden shrink-0 flex-col rounded-none border-t-0 border-r-0 border-b-0 border-l lg:flex"
          style={{ width: rightPanelWidth }}
        >
          <TaskExecutionPanel
            tasks={tasks}
            taskProgress={taskProgress}
            toolCalls={allToolCalls}
            isGenerating={isGenerating}
          />
        </aside>
      </motion.div>

      {/* Settings modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        thinkingEnabled={thinkingEnabled}
        onThinkingToggle={setThinkingEnabled}
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
    </div>
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
      const content = getInternalMessageContent(msg);
      const textContent = extractText(content);
      if (textContent) {
        result.push({ id: id++, role: "user", content: textContent });
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
      result.push({ id: id++, role: "user", content: extractText(msg.content) });
    } else if (role === "assistant") {
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
