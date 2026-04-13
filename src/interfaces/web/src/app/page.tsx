"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Cpu,
  Settings,
  MessageSquare,
  Loader2,
  ChevronDown,
  Brain,
  AlertTriangle,
  KeyRound,
  Trash2,
  Clock,
} from "lucide-react";
import { Message, UsageInfo, Session, TaskInfo, TaskProgress } from "@/types";
import {
  createSession,
  sendChatMessage,
  fetchModels,
  getApiKey,
  setApiKey,
  clearApiKey,
  AuthError,
  fetchSessions,
  fetchSessionDetails,
  deleteSession,
} from "@/lib/api";
import SettingsModal from "@/components/SettingsModal";
import ChatMessage from "@/components/ChatMessage";
import TaskExecutionPanel from "@/components/TaskExecutionPanel";

const RippleIcon = ({ size = 24, className = "" }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="12" r="10" opacity="0.3" />
    <circle cx="12" cy="12" r="6" opacity="0.6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

const MAX_CONTEXT_TOKENS = 200_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("sonnet");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [authState, setAuthState] = useState<"checking" | "needs_auth" | "authenticated">(
    "checking"
  );
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [keyInput, setKeyInput] = useState("");

  // Token usage state (cumulative across turns)
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  const [lastContextTokens, setLastContextTokens] = useState(0);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  // Task progress tracking
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);

  // Resizable right panel
  const [rightPanelWidth, setRightPanelWidth] = useState(420);
  const isResizingRef = useRef(false);
  const RIGHT_PANEL_MIN = 320;
  const RIGHT_PANEL_MAX = 700;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = rightPanelWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return;
        const delta = startX - ev.clientX;
        const newWidth = Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, startWidth + delta));
        setRightPanelWidth(newWidth);
      };

      const handleMouseUp = () => {
        isResizingRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [rightPanelWidth]
  );

  // Accumulate all tool calls across messages for the execution panel
  const allToolCalls = messages.flatMap((m) =>
    m.role === "assistant" && m.toolCalls ? m.toolCalls : []
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setAuthState(getApiKey() ? "authenticated" : "needs_auth");
  }, []);

  const loadSessions = useCallback(async () => {
    if (authState !== "authenticated") return;
    try {
      setIsLoadingSessions(true);
      const fetchedSessions = await fetchSessions();
      setSessions(fetchedSessions);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setIsLoadingSessions(false);
    }
  }, [authState]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    async function init() {
      try {
        const fetchedModels = await fetchModels();
        setModels(fetchedModels);
        if (fetchedModels.length > 0) {
          const defaultModel = fetchedModels.find((m) => m.id === "sonnet") || fetchedModels[0];
          setSelectedModel(defaultModel.id);
        }
        await loadSessions();
      } catch (err) {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState("needs_auth");
          setAuthErrorMsg("API Key 无效，请重新输入");
        }
      }
    }
    init();
  }, [authState, loadSessions]);

  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    setApiKey(keyInput.trim());
    setKeyInput("");
    setAuthErrorMsg("");
    setAuthState("authenticated");
  };

  const handleSwitchSession = async (id: string) => {
    if (id === sessionId) return;
    if (isGenerating) return;

    try {
      const details = await fetchSessionDetails(id);
      if (details) {
        setSessionId(id);
        setSelectedModel(details.model);

        // Map backend messages to frontend format
        const mappedMessages: Message[] = [];
        let currentMsgId = Date.now();

        for (const msg of details.messages) {
          if (msg.role === "user") {
            let contentStr = "";
            if (typeof msg.content === "string") {
              try {
                const parsed = JSON.parse(msg.content);
                if (Array.isArray(parsed)) {
                  contentStr = parsed
                    .filter((c: { type: string; text?: string }) => c.type === "text")
                    .map((c: { text?: string }) => c.text || "")
                    .join("\n");
                } else {
                  contentStr = msg.content;
                }
              } catch {
                contentStr = msg.content;
              }
            } else if (Array.isArray(msg.content)) {
              contentStr = msg.content
                .filter((c: { type: string; text?: string }) => c.type === "text")
                .map((c: { text?: string }) => c.text || "")
                .join("\n");
            } else {
              contentStr = JSON.stringify(msg.content);
            }
            mappedMessages.push({
              id: currentMsgId++,
              role: "user",
              content: contentStr,
            });
          } else if (msg.role === "assistant") {
            let contentStr = "";
            if (typeof msg.content === "string") {
              try {
                const parsed = JSON.parse(msg.content);
                if (Array.isArray(parsed)) {
                  contentStr = parsed
                    .filter((c: { type: string; text?: string }) => c.type === "text")
                    .map((c: { text?: string }) => c.text || "")
                    .join("");
                } else {
                  contentStr = msg.content;
                }
              } catch {
                contentStr = msg.content;
              }
            } else if (msg.content && Array.isArray(msg.content)) {
              contentStr = msg.content
                .filter((c: { type: string; text?: string }) => c.type === "text")
                .map((c: { text?: string }) => c.text || "")
                .join("");
            }
            const rawToolCalls = msg.tool_calls as
              | {
                  id: string;
                  function?: { name: string; arguments: string | Record<string, unknown> };
                }[]
              | undefined;
            const toolCalls =
              rawToolCalls?.map((tc) => ({
                id: tc.id,
                name: tc.function?.name || "unknown",
                arguments: tc.function?.arguments || {},
                status: "success" as const,
                result: "",
              })) || [];

            mappedMessages.push({
              id: currentMsgId++,
              role: "assistant",
              content: contentStr,
              toolCalls: toolCalls,
            });
          } else if (msg.role === "tool") {
            // Find the last assistant message with this tool call and attach the result
            for (let i = mappedMessages.length - 1; i >= 0; i--) {
              const m = mappedMessages[i];
              if (m.role === "assistant" && m.toolCalls) {
                const tc = m.toolCalls.find((t) => t.id === msg.tool_call_id);
                if (tc) {
                  tc.result =
                    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                  break;
                }
              }
            }
          }
        }

        setMessages(mappedMessages);
        setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }); // Reset or fetch from details if available
        setLastContextTokens(0);
      }
    } catch (err) {
      console.error("Error switching session:", err);
    }
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isGenerating) return;

    const success = await deleteSession(id);
    if (success) {
      setSessions((prev) => prev.filter((s) => s.session_id !== id));
      if (id === sessionId) {
        setSessionId(null);
        setMessages([]);
        setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        setLastContextTokens(0);
      }
    }
  };

  const handleSendMessage = useCallback(
    async (messageContent: string) => {
      if (!messageContent.trim() || isGenerating) return;

      let activeSessionId = sessionId;
      if (!activeSessionId) {
        try {
          activeSessionId = await createSession();
          setSessionId(activeSessionId);
        } catch (err) {
          if (err instanceof AuthError) {
            clearApiKey();
            setAuthState("needs_auth");
            setAuthErrorMsg("API Key 已失效，请重新输入");
          }
          return;
        }
      }

      const userMsg: Message = {
        id: Date.now(),
        role: "user",
        content: messageContent,
      };

      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: Date.now() + 1,
          role: "assistant",
          content: "",
          toolCalls: [],
        },
      ]);

      setInput("");
      setIsGenerating(true);
      setTasks([]);
      setTaskProgress(null);

      let currentContent = "";

      await sendChatMessage(activeSessionId, messageContent, selectedModel, thinkingEnabled, {
        onMessageDelta: (delta) => {
          currentContent += delta;
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg.role === "assistant") {
              lastMsg.content = currentContent;
            }
            return newMessages;
          });
        },
        onToolCall: (toolCall) => {
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg.role === "assistant") {
              const existingToolIndex = lastMsg.toolCalls?.findIndex((t) => t.id === toolCall.id);
              if (existingToolIndex !== undefined && existingToolIndex >= 0 && lastMsg.toolCalls) {
                lastMsg.toolCalls[existingToolIndex] = toolCall;
              } else {
                lastMsg.toolCalls = [...(lastMsg.toolCalls || []), toolCall];
              }

              if (toolCall.name === "AskUser") {
                const args =
                  typeof toolCall.arguments === "string"
                    ? JSON.parse(toolCall.arguments)
                    : toolCall.arguments;
                if (args?.options?.length > 0) {
                  lastMsg.askUser = {
                    question: args.question || "",
                    options: args.options,
                  };
                }
              }
            }
            return newMessages;
          });
        },
        onNewTurn: () => {
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
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg.role === "assistant" && lastMsg.toolCalls) {
              const tool = lastMsg.toolCalls.find((t) => t.id === toolId);
              if (tool) {
                tool.status = "success";
                tool.result = result;
              }
            }
            return newMessages;
          });
        },
        onTaskCreated: (task) => {
          setTasks((prev) => {
            if (prev.some((t) => t.id === task.id)) return prev;
            return [...prev, task];
          });
        },
        onTaskUpdated: (task) => {
          setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...task } : t)));
        },
        onTaskProgress: (progress) => {
          setTaskProgress(progress);
        },
        onPermissionRequest: (request) => {
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg.role === "assistant") {
              lastMsg.permissionRequest = request;
            }
            return newMessages;
          });
        },
        onUsage: (usage) => {
          setTokenUsage((prev) => ({
            prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
            completion_tokens: prev.completion_tokens + usage.completion_tokens,
            total_tokens: prev.total_tokens + usage.total_tokens,
          }));
          if (usage.prompt_tokens > 0) {
            setLastContextTokens(usage.prompt_tokens);
          }
        },
        onComplete: () => {
          setIsGenerating(false);
          loadSessions(); // Refresh sessions list after generation completes
        },
        onError: (err) => {
          if (err instanceof AuthError) {
            clearApiKey();
            setAuthState("needs_auth");
            setAuthErrorMsg("API Key 已失效，请重新输入");
            setIsGenerating(false);
            return;
          }
          console.error("Chat error:", err);
          setIsGenerating(false);
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg.role === "assistant" && !lastMsg.content) {
              lastMsg.content =
                "Failed to connect to Ripple Server. Please ensure the server is running on port 8810.";
            }
            return newMessages;
          });
        },
      });
    },
    [isGenerating, sessionId, selectedModel, thinkingEnabled, loadSessions]
  );

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleSendMessage(input);
  };

  const handleQuickReply = (option: string) => {
    handleSendMessage(option);
  };

  const contextPercent =
    lastContextTokens > 0 ? Math.min((lastContextTokens / MAX_CONTEXT_TOKENS) * 100, 100) : 0;
  const isContextWarning = contextPercent > 75;

  const lastAssistantMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant");
  const activeAskUser = lastAssistantMessage?.askUser;
  const activePermissionRequest = lastAssistantMessage?.permissionRequest;

  const handlePermissionResolve = (action: "allow" | "always" | "deny") => {
    // Call the API endpoint to resolve the permission request
    // For now, we will just clear the UI state and simulate a response
    console.log("Permission resolved:", action);
    // TODO: Implement actual API call to unblock backend execution
  };

  if (authState !== "authenticated") {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-slate-50 font-[family-name:var(--font-inter)]">
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="animate-blob absolute top-[-10%] left-[-10%] h-96 w-96 rounded-full bg-purple-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
          <div className="animate-blob animation-delay-2000 absolute top-[20%] right-[-10%] h-96 w-96 rounded-full bg-yellow-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
          <div className="animate-blob animation-delay-4000 absolute bottom-[-20%] left-[20%] h-96 w-96 rounded-full bg-pink-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
        </div>
        {authState === "needs_auth" && (
          <div className="relative z-10 flex h-full items-center justify-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mx-4 w-full max-w-md"
            >
              <div className="glass-bubble rounded-3xl p-8 shadow-xl">
                <div className="mb-8 flex flex-col items-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-purple-500/30">
                    <RippleIcon size={36} className="text-white" />
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
                      className="w-full rounded-2xl border border-slate-200 bg-white py-3.5 pr-4 pl-12 text-slate-700 transition-all placeholder:text-slate-400 focus:border-violet-300 focus:ring-2 focus:ring-violet-500/50 focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!keyInput.trim()}
                    className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 py-3.5 font-semibold text-white shadow-lg shadow-purple-500/25 transition-all hover:shadow-purple-500/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    连接
                  </button>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-50 font-[family-name:var(--font-inter)]">
      {/* Animated Background Blobs */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="animate-blob absolute top-[-10%] left-[-10%] h-96 w-96 rounded-full bg-purple-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
        <div className="animate-blob animation-delay-2000 absolute top-[20%] right-[-10%] h-96 w-96 rounded-full bg-yellow-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
        <div className="animate-blob animation-delay-4000 absolute bottom-[-20%] left-[20%] h-96 w-96 rounded-full bg-pink-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
        <div className="animate-blob absolute right-[30%] bottom-[10%] h-72 w-72 rounded-full bg-blue-300 opacity-50 mix-blend-multiply blur-3xl filter"></div>
      </div>

      {/* App Container */}
      <div className="relative z-10 flex h-full w-full">
        {/* Sidebar */}
        <aside className="glass-panel hidden w-72 flex-shrink-0 flex-col border-r border-white/40 md:flex">
          <div className="flex items-center gap-3 p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-purple-500/30">
              <RippleIcon size={22} className="text-white" />
            </div>
            <h1 className="bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-xl font-bold tracking-tight text-transparent">
              Ripple
            </h1>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="mb-6 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/50 bg-white/80 px-4 py-3 font-semibold text-slate-700 shadow-sm transition-colors hover:bg-white"
              onClick={async () => {
                if (isGenerating) return;
                setMessages([]);
                setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
                setLastContextTokens(0);
                try {
                  const id = await createSession();
                  setSessionId(id);
                  const now = new Date().toISOString();
                  setSessions((prev) => [
                    {
                      session_id: id,
                      title: "New Chat",
                      model: selectedModel,
                      created_at: now,
                      last_active: now,
                      message_count: 0,
                      status: "active",
                    },
                    ...prev,
                  ]);
                } catch (err) {
                  if (err instanceof AuthError) {
                    clearApiKey();
                    setAuthState("needs_auth");
                    setAuthErrorMsg("API Key 已失效，请重新输入");
                  }
                }
              }}
            >
              <MessageSquare size={18} className="text-violet-500" />
              <span>New Chat</span>
            </motion.button>

            <div className="mb-6 space-y-2">
              <h2 className="mb-3 px-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
                Recent Sessions
              </h2>
              {isLoadingSessions && sessions.length === 0 ? (
                <div className="flex justify-center p-4">
                  <Loader2 size={16} className="animate-spin text-slate-400" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="px-3 py-2 text-center text-xs text-slate-400">
                  No recent sessions
                </div>
              ) : (
                <div className="space-y-1">
                  {sessions.map((session) => (
                    <div
                      key={session.session_id}
                      onClick={() => handleSwitchSession(session.session_id)}
                      className={`group flex cursor-pointer items-center justify-between rounded-2xl border p-3 shadow-sm transition-all ${
                        session.session_id === sessionId
                          ? "border-violet-200 bg-white shadow-violet-100/50"
                          : "border-transparent bg-white/40 hover:border-slate-200 hover:bg-white/80"
                      }`}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div
                          className={`h-2 w-2 flex-shrink-0 rounded-full ${
                            session.session_id === sessionId
                              ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]"
                              : "bg-slate-300"
                          }`}
                        ></div>
                        <div className="flex flex-col overflow-hidden">
                          <span
                            className={`truncate text-sm font-medium ${
                              session.session_id === sessionId ? "text-slate-700" : "text-slate-500"
                            }`}
                          >
                            {session.title || session.session_id.substring(0, 12) + "..."}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">
                            <Clock size={10} />
                            {new Date(session.last_active).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            <span className="mx-1">•</span>
                            {session.message_count} msgs
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => handleDeleteSession(session.session_id, e)}
                        className="rounded-lg p-1.5 text-slate-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 focus:outline-none"
                        title="Delete Session"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Token Usage Summary in sidebar */}
            {tokenUsage.total_tokens > 0 && (
              <div className="mt-4 space-y-2">
                <h2 className="px-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
                  Token Usage
                </h2>
                <div className="space-y-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
                  {lastContextTokens > 0 && (
                    <div>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-slate-500">Context</span>
                        <span
                          className={`font-mono font-semibold ${isContextWarning ? "text-amber-600" : "text-slate-600"}`}
                        >
                          {contextPercent.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isContextWarning ? "bg-amber-400" : "bg-violet-400"
                          }`}
                          style={{ width: `${contextPercent}%` }}
                        />
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-slate-400">
                        {formatTokens(lastContextTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)}
                      </p>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Total</span>
                    <span className="font-mono font-semibold text-slate-600">
                      <span className="text-emerald-600">
                        {formatTokens(tokenUsage.prompt_tokens)}
                      </span>
                      {" / "}
                      <span className="text-blue-600">
                        {formatTokens(tokenUsage.completion_tokens)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            className="m-4 flex cursor-pointer items-center justify-between rounded-2xl border border-white/50 bg-white/50 p-4 transition-colors hover:bg-white/80"
            onClick={() => setIsSettingsOpen(true)}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200">
                <Settings size={16} className="text-slate-600" />
              </div>
              <span className="text-sm font-semibold text-slate-700">Settings</span>
            </div>
          </div>
        </aside>

        {/* Main Chat Area */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="glass-panel z-20 flex h-16 items-center justify-between border-b border-white/40 px-6">
            <div className="flex items-center gap-3">
              {/* Model selector */}
              <div className="relative">
                <button
                  onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                  className="flex items-center gap-2 rounded-full border border-white/60 bg-white/50 px-3 py-1.5 text-slate-600 transition-colors hover:bg-white/80"
                >
                  <Cpu size={16} className="text-violet-500" />
                  <span className="text-sm font-semibold">{selectedModel}</span>
                  <ChevronDown
                    size={14}
                    className={`text-slate-400 transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>

                <AnimatePresence>
                  {isModelDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      transition={{ duration: 0.15 }}
                      className="absolute top-full left-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-200/50"
                    >
                      <div className="p-1">
                        {models.length > 0 ? (
                          models.map((model) => (
                            <button
                              key={model.id}
                              onClick={() => {
                                setSelectedModel(model.id);
                                setIsModelDropdownOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                                selectedModel === model.id
                                  ? "bg-violet-50 text-violet-700"
                                  : "text-slate-600 hover:bg-slate-50"
                              }`}
                            >
                              {model.id}
                              {selectedModel === model.id && (
                                <div className="h-1.5 w-1.5 rounded-full bg-violet-500"></div>
                              )}
                            </button>
                          ))
                        ) : (
                          <div className="px-3 py-2 text-sm text-slate-400">No models found</div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Thinking badge */}
              {thinkingEnabled && (
                <div className="flex items-center gap-1.5 rounded-full border border-violet-100/50 bg-violet-50 px-2.5 py-1 text-violet-600">
                  <Brain size={12} />
                  <span className="text-[10px] font-bold tracking-wide">THINKING</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {/* Token usage compact */}
              {tokenUsage.total_tokens > 0 && (
                <div
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs ${
                    isContextWarning
                      ? "border-amber-200/50 bg-amber-50 text-amber-700"
                      : "border-slate-200/50 bg-slate-50 text-slate-500"
                  }`}
                >
                  {isContextWarning && <AlertTriangle size={12} />}
                  <span>{formatTokens(tokenUsage.prompt_tokens)}</span>
                  <span className="text-slate-300">|</span>
                  <span>{formatTokens(tokenUsage.completion_tokens)}</span>
                </div>
              )}

              {/* Status indicator */}
              <div
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
                  sessionId
                    ? "border-green-100/50 bg-green-50 text-green-600"
                    : "border-slate-200/50 bg-slate-50 text-slate-500"
                }`}
              >
                <div
                  className={`h-2 w-2 rounded-full ${sessionId ? "animate-pulse bg-green-500" : "bg-slate-400"}`}
                ></div>
                <span className="text-xs font-bold tracking-wide">
                  {sessionId ? "ACTIVE" : "READY"}
                </span>
              </div>
            </div>
          </header>

          {/* Messages */}
          <div className="flex-1 space-y-8 overflow-y-auto p-4 pb-10 md:p-6">
            <div className="mx-auto max-w-3xl space-y-6">
              {messages.length === 0 && (
                <div className="flex h-64 flex-col items-center justify-center text-slate-400">
                  <RippleIcon size={48} className="mb-4 text-violet-200" />
                  <p className="text-lg font-medium">How can I help you today?</p>
                </div>
              )}

              <AnimatePresence initial={false}>
                {messages.map((msg, index) => (
                  <ChatMessage
                    key={msg.id}
                    msg={msg}
                    isGenerating={isGenerating}
                    isLast={index === messages.length - 1}
                  />
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} className="h-32" />
            </div>
          </div>

          {/* Input Area */}
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 z-20 bg-gradient-to-t from-slate-50 via-slate-50/95 to-transparent p-6">
            <div className="pointer-events-auto mx-auto max-w-3xl">
              <form onSubmit={handleSend} className="relative flex items-center">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={isGenerating}
                  placeholder={
                    isGenerating
                      ? "Ripple is thinking..."
                      : !sessionId
                        ? "输入消息开始新对话..."
                        : "Ask Ripple anything..."
                  }
                  className="glass-bubble w-full rounded-full py-4 pr-16 pl-6 text-base text-slate-700 shadow-lg shadow-slate-200/50 transition-all placeholder:text-slate-400 focus:ring-2 focus:ring-violet-500/50 focus:outline-none disabled:opacity-70"
                />
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  type="submit"
                  disabled={isGenerating || !input.trim()}
                  className="absolute right-2 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-purple-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isGenerating ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Send size={18} className="ml-0.5" />
                  )}
                </motion.button>
              </form>
              <div className="mt-3 text-center">
                <span className="text-[10px] font-medium tracking-wide text-slate-400">
                  RIPPLE AGENT LOOP IS ACTIVE
                </span>
              </div>
            </div>
          </div>
        </main>

        {/* Resizable Divider */}
        <div
          className="hidden w-1.5 flex-shrink-0 cursor-col-resize items-center justify-center hover:bg-violet-200/50 active:bg-violet-300/50 lg:flex"
          onMouseDown={handleResizeStart}
        >
          <div className="h-8 w-0.5 rounded-full bg-slate-300 transition-colors group-hover:bg-violet-400" />
        </div>

        {/* Task Execution Panel (Right Column) */}
        <aside
          className="glass-panel hidden flex-shrink-0 flex-col border-l border-white/40 lg:flex"
          style={{ width: rightPanelWidth }}
        >
          <TaskExecutionPanel
            tasks={tasks}
            taskProgress={taskProgress}
            toolCalls={allToolCalls}
            askUser={activeAskUser}
            permissionRequest={activePermissionRequest}
            onQuickReply={handleQuickReply}
            onPermissionResolve={handlePermissionResolve}
            isGenerating={isGenerating}
          />
        </aside>
      </div>

      {/* Settings Modal */}
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
