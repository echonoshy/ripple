"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cpu, ChevronDown, Brain, AlertTriangle, KeyRound, Menu } from "lucide-react";
import { Message, UsageInfo, Session, TaskInfo, TaskProgress } from "@/types";
import {
  createSession,
  sendChatMessage,
  stopSession,
  fetchModels,
  getApiKey,
  setApiKey,
  clearApiKey,
  AuthError,
  fetchSessions,
  fetchSessionDetails,
  deleteSession,
} from "@/lib/api";
import RippleIcon from "@/components/icons/RippleIcon";
import Sidebar from "@/components/Sidebar";
import ChatInput from "@/components/ChatInput";
import ChatMessage from "@/components/ChatMessage";
import TaskExecutionPanel from "@/components/TaskExecutionPanel";
import SettingsModal from "@/components/SettingsModal";

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

  // ── UI state ──
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);

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
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const isResizingRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Scroll to bottom on new messages ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Auth check ──
  useEffect(() => {
    setAuthState(getApiKey() ? "authenticated" : "needs_auth");
  }, []);

  // ── Load sessions ──
  const loadSessions = useCallback(async () => {
    if (authState !== "authenticated") return;
    try {
      setIsLoadingSessions(true);
      setSessions(await fetchSessions());
    } catch {
      /* swallow */
    } finally {
      setIsLoadingSessions(false);
    }
  }, [authState]);

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
        await loadSessions();
      } catch (err) {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState("needs_auth");
          setAuthErrorMsg("API Key 无效，请重新输入");
        }
      }
    })();
  }, [authState, loadSessions]);

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
      setSessionId(id);
      setSelectedModel(details.model);
      setMessages(mapBackendMessages(details.messages));
      setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      setLastContextTokens(0);
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
      await loadSessions();
    } catch (err) {
      if (err instanceof AuthError) {
        clearApiKey();
        setAuthState("needs_auth");
        setAuthErrorMsg("API Key 已失效");
      }
    }
  };

  // ── Delete session ──
  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isGenerating) return;
    if (await deleteSession(id)) {
      setSessions((prev) => prev.filter((s) => s.session_id !== id));
      if (id === sessionId) {
        setSessionId(null);
        setMessages([]);
      }
    }
  };

  // ── Stop generation ──
  const handleStop = useCallback(async () => {
    if (sessionId) {
      await stopSession(sessionId);
    }
    setIsGenerating(false);
  }, [sessionId]);

  // ── Send message ──
  const handleSendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isGenerating) return;

    let activeSessionId = sessionId;
    if (!activeSessionId) {
      try {
        activeSessionId = await createSession();
        setSessionId(activeSessionId);
      } catch (err) {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState("needs_auth");
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
    setTasks([]);
    setTaskProgress(null);

    let currentContent = "";

    await sendChatMessage(activeSessionId, text, selectedModel, thinkingEnabled, {
      onMessageDelta: (delta) => {
        currentContent += delta;
        setMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last.role === "assistant") last.content = currentContent;
          return msgs;
        });
      },
      onToolCall: (toolCall) => {
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
                if (args?.options?.length > 0) {
                  last.askUser = { question: args.question || "", options: args.options };
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
        currentContent = "";
        setMessages((prev) => [
          ...prev,
          { id: Date.now() + Math.random(), role: "assistant", content: "", toolCalls: [] },
        ]);
      },
      onToolResult: (toolId, result) => {
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
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]));
      },
      onTaskUpdated: (task) => {
        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...task } : t)));
      },
      onTaskProgress: (progress) => setTaskProgress(progress),
      onAgentStop: () => {
        // Agent paused (e.g. awaiting user input). Generation ends via onComplete.
      },
      onPermissionRequest: (request) => {
        setMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last.role === "assistant") last.permissionRequest = request;
          return msgs;
        });
      },
      onUsage: (usage) => {
        setTokenUsage((prev) => ({
          prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
          completion_tokens: prev.completion_tokens + usage.completion_tokens,
          total_tokens: prev.total_tokens + usage.total_tokens,
        }));
        if (usage.prompt_tokens > 0) setLastContextTokens(usage.prompt_tokens);
      },
      onComplete: () => {
        setIsGenerating(false);
        loadSessions();
      },
      onError: (err) => {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState("needs_auth");
          setAuthErrorMsg("API Key 已失效");
          setIsGenerating(false);
          return;
        }
        console.error("Chat error:", err);
        setIsGenerating(false);
        setMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last.role === "assistant" && !last.content) {
            last.content = "无法连接到 Ripple 服务。请确认服务端正在运行。";
          }
          return msgs;
        });
      },
    });
  }, [input, isGenerating, sessionId, selectedModel, thinkingEnabled, loadSessions]);

  const handleQuickReply = (option: string) => {
    setInput(option);
    setTimeout(() => {
      const el = document.querySelector("textarea");
      el?.focus();
    }, 50);
  };

  // ── Resize right panel ──
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = rightPanelWidth;
      const onMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return;
        setRightPanelWidth(Math.min(600, Math.max(300, startWidth + startX - ev.clientX)));
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
  const lastAssistant = messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant");

  const isContextWarning = lastContextTokens > 150_000;

  // ═══════════════════════════════════════════════════════
  // AUTH SCREEN
  // ═══════════════════════════════════════════════════════
  if (authState !== "authenticated") {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-slate-50">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob absolute top-[-10%] left-[-10%] h-96 w-96 rounded-full bg-purple-300 opacity-40 mix-blend-multiply blur-3xl" />
          <div className="animate-blob animation-delay-2000 absolute top-[20%] right-[-10%] h-96 w-96 rounded-full bg-yellow-300 opacity-40 mix-blend-multiply blur-3xl" />
          <div className="animate-blob animation-delay-4000 absolute bottom-[-20%] left-[20%] h-96 w-96 rounded-full bg-pink-300 opacity-40 mix-blend-multiply blur-3xl" />
        </div>
        {authState === "needs_auth" && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative z-10 mx-4 w-full max-w-sm"
          >
            <div className="glass-bubble rounded-3xl p-8 shadow-xl">
              <div className="mb-8 flex flex-col items-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-purple-500/30">
                  <RippleIcon size={32} className="text-white" />
                </div>
                <h1 className="bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-2xl font-bold text-transparent">
                  Ripple
                </h1>
                <p className="mt-2 text-sm text-slate-400">请输入 API Key 以访问服务</p>
              </div>
              {authErrorMsg && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-600">
                  <AlertTriangle size={16} />
                  <span>{authErrorMsg}</span>
                </div>
              )}
              <form onSubmit={handleAuthSubmit}>
                <div className="relative mb-4">
                  <KeyRound
                    size={18}
                    className="absolute top-1/2 left-4 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="Enter your API Key"
                    className="w-full rounded-xl border border-slate-200 bg-white py-3 pr-4 pl-11 text-slate-700 placeholder:text-slate-400 focus:border-violet-300 focus:ring-2 focus:ring-violet-500/50 focus:outline-none"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={!keyInput.trim()}
                  className="w-full rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 py-3 font-semibold text-white shadow-lg shadow-purple-500/25 transition-all hover:shadow-purple-500/40 disabled:opacity-50"
                >
                  连接
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
    <div className="relative h-screen w-screen overflow-hidden bg-slate-50">
      {/* Background blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute top-[-10%] left-[-10%] h-96 w-96 rounded-full bg-purple-200 opacity-40 mix-blend-multiply blur-3xl" />
        <div className="animate-blob animation-delay-2000 absolute top-[20%] right-[-10%] h-96 w-96 rounded-full bg-yellow-200 opacity-40 mix-blend-multiply blur-3xl" />
        <div className="animate-blob animation-delay-4000 absolute bottom-[-20%] left-[20%] h-96 w-96 rounded-full bg-pink-200 opacity-40 mix-blend-multiply blur-3xl" />
      </div>

      <div className="relative z-10 flex h-full w-full">
        {/* Sidebar */}
        <Sidebar
          sessions={sessions}
          currentSessionId={sessionId}
          isLoadingSessions={isLoadingSessions}
          isGenerating={isGenerating}
          tokenUsage={tokenUsage}
          lastContextTokens={lastContextTokens}
          isMobileOpen={isSidebarOpen}
          onNewChat={handleNewChat}
          onSwitchSession={handleSwitchSession}
          onDeleteSession={handleDeleteSession}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onCloseMobile={() => setIsSidebarOpen(false)}
        />

        {/* Main chat area */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="glass-panel z-20 flex h-14 items-center justify-between border-b border-white/40 px-4 md:px-6">
            <div className="flex items-center gap-2">
              {/* Mobile menu */}
              <button
                onClick={() => setIsSidebarOpen(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 md:hidden"
              >
                <Menu size={18} />
              </button>

              {/* Model selector */}
              <div className="relative">
                <button
                  onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/60 bg-white/50 px-2.5 py-1.5 text-sm text-slate-600 transition-colors hover:bg-white/80"
                >
                  <Cpu size={14} className="text-violet-500" />
                  <span className="font-semibold">{selectedModel}</span>
                  <ChevronDown
                    size={12}
                    className={`text-slate-400 transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>
                <AnimatePresence>
                  {isModelDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      transition={{ duration: 0.12 }}
                      className="absolute top-full left-0 z-50 mt-1 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
                    >
                      <div className="p-1">
                        {models.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => {
                              setSelectedModel(m.id);
                              setIsModelDropdownOpen(false);
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                              selectedModel === m.id
                                ? "bg-violet-50 font-semibold text-violet-700"
                                : "text-slate-600 hover:bg-slate-50"
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
                <div className="flex items-center gap-1 rounded-md bg-violet-50 px-2 py-1 text-violet-600">
                  <Brain size={11} />
                  <span className="text-[10px] font-bold tracking-wide">THINK</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {tokenUsage.total_tokens > 0 && (
                <div
                  className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] sm:flex ${
                    isContextWarning
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-slate-200 bg-slate-50 text-slate-500"
                  }`}
                >
                  {isContextWarning && <AlertTriangle size={11} />}
                  <span>↑{formatTokens(tokenUsage.prompt_tokens)}</span>
                  <span className="text-slate-300">|</span>
                  <span>↓{formatTokens(tokenUsage.completion_tokens)}</span>
                </div>
              )}
              <div
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
                  sessionId
                    ? "border-green-100 bg-green-50 text-green-600"
                    : "border-slate-200 bg-slate-50 text-slate-500"
                }`}
              >
                <div
                  className={`h-1.5 w-1.5 rounded-full ${sessionId ? "animate-pulse bg-green-500" : "bg-slate-400"}`}
                />
                <span className="text-[10px] font-bold tracking-wide">
                  {sessionId ? "ACTIVE" : "READY"}
                </span>
              </div>
            </div>
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 pt-6 pb-40 md:px-6">
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.length === 0 && (
                <div className="flex h-[50vh] flex-col items-center justify-center text-slate-400">
                  <RippleIcon size={48} className="mb-4 text-violet-200" />
                  <p className="text-lg font-medium">How can I help you today?</p>
                  <p className="mt-1 text-sm text-slate-300">输入消息开始对话</p>
                </div>
              )}
              <AnimatePresence initial={false}>
                {messages.map((msg, i) => (
                  <ChatMessage
                    key={msg.id}
                    msg={msg}
                    isGenerating={isGenerating}
                    isLast={i === messages.length - 1}
                  />
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSendMessage}
            onStop={handleStop}
            isGenerating={isGenerating}
            hasSession={!!sessionId}
          />
        </main>

        {/* Resize handle */}
        <div
          className="hidden w-1 shrink-0 cursor-col-resize items-center justify-center hover:bg-violet-200/50 lg:flex"
          onMouseDown={handleResizeStart}
        >
          <div className="h-8 w-0.5 rounded-full bg-slate-300" />
        </div>

        {/* Right panel */}
        <aside
          className="glass-panel hidden shrink-0 flex-col border-l border-white/40 lg:flex"
          style={{ width: rightPanelWidth }}
        >
          <TaskExecutionPanel
            tasks={tasks}
            taskProgress={taskProgress}
            toolCalls={allToolCalls}
            askUser={lastAssistant?.askUser}
            permissionRequest={lastAssistant?.permissionRequest}
            onQuickReply={handleQuickReply}
            onPermissionResolve={(action) => {
              if (action === "deny") {
                handleSendMessage();
              } else {
                setInput("Approved. Please proceed.");
                setTimeout(() => handleSendMessage(), 100);
              }
            }}
            isGenerating={isGenerating}
          />
        </aside>
      </div>

      {/* Settings modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        thinkingEnabled={thinkingEnabled}
        onThinkingToggle={setThinkingEnabled}
        apiKey={getApiKey()}
        onApiKeyChange={() => {
          clearApiKey();
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

function mapBackendMessages(raw: Record<string, unknown>[]): Message[] {
  const result: Message[] = [];
  let id = Date.now();

  for (const msg of raw) {
    const role = msg.role as string;

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
      result.push({ id: id++, role: "assistant", content: extractText(msg.content), toolCalls });
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
  return result;
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
