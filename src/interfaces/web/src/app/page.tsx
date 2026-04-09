"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Cpu, Settings, MessageSquare, Wrench, ChevronRight,
  User, Loader2, ChevronDown, Brain, AlertTriangle, KeyRound,
} from "lucide-react";
import { Message, ToolCall, UsageInfo } from "@/types";
import { createSession, sendChatMessage, fetchModels, getApiKey, setApiKey, clearApiKey, AuthError } from "@/lib/api";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import SettingsModal from "@/components/SettingsModal";

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
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("sonnet");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [authState, setAuthState] = useState<'checking' | 'needs_auth' | 'authenticated'>('checking');
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [keyInput, setKeyInput] = useState("");

  // Token usage state (cumulative across turns)
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  const [lastContextTokens, setLastContextTokens] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setAuthState(getApiKey() ? 'authenticated' : 'needs_auth');
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    async function init() {
      try {
        const id = await createSession();
        setSessionId(id);
        const fetchedModels = await fetchModels();
        setModels(fetchedModels);
        if (fetchedModels.length > 0) {
          const defaultModel = fetchedModels.find(m => m.id === 'sonnet') || fetchedModels[0];
          setSelectedModel(defaultModel.id);
        }
      } catch (err) {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState('needs_auth');
          setAuthErrorMsg("API Key 无效，请重新输入");
        }
      }
    }
    init();
  }, [authState]);

  const toggleTool = (id: string) => {
    setExpandedTools(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    setApiKey(keyInput.trim());
    setKeyInput("");
    setAuthErrorMsg("");
    setAuthState('authenticated');
  };

  const handleSendMessage = useCallback(async (messageContent: string) => {
    if (!messageContent.trim() || isGenerating || !sessionId) return;

    const userMsg: Message = {
      id: Date.now(),
      role: "user",
      content: messageContent,
    };

    setMessages(prev => [...prev, userMsg, {
      id: Date.now() + 1,
      role: "assistant",
      content: "",
      toolCalls: [],
    }]);

    setInput("");
    setIsGenerating(true);

    let currentContent = "";

    await sendChatMessage(sessionId, messageContent, selectedModel, thinkingEnabled, {
      onMessageDelta: (delta) => {
        currentContent += delta;
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          if (lastMsg.role === 'assistant') {
            lastMsg.content = currentContent;
          }
          return newMessages;
        });
      },
      onToolCall: (toolCall) => {
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          if (lastMsg.role === 'assistant') {
            const existingToolIndex = lastMsg.toolCalls?.findIndex(t => t.id === toolCall.id);
            if (existingToolIndex !== undefined && existingToolIndex >= 0 && lastMsg.toolCalls) {
              lastMsg.toolCalls[existingToolIndex] = toolCall;
            } else {
              lastMsg.toolCalls = [...(lastMsg.toolCalls || []), toolCall];
              setExpandedTools(prev => ({ ...prev, [toolCall.id]: true }));
            }

            if (toolCall.name === "AskUser") {
              const args = typeof toolCall.arguments === 'string'
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
      onToolResult: (toolId, result) => {
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          if (lastMsg.role === 'assistant' && lastMsg.toolCalls) {
            const tool = lastMsg.toolCalls.find(t => t.id === toolId);
            if (tool) {
              tool.status = 'success';
              tool.result = result;
            }
          }
          return newMessages;
        });
      },
      onUsage: (usage) => {
        setTokenUsage(prev => ({
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
      },
      onError: (err) => {
        if (err instanceof AuthError) {
          clearApiKey();
          setAuthState('needs_auth');
          setAuthErrorMsg("API Key 已失效，请重新输入");
          setIsGenerating(false);
          return;
        }
        console.error("Chat error:", err);
        setIsGenerating(false);
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          if (lastMsg.role === 'assistant' && !lastMsg.content) {
            lastMsg.content = "Failed to connect to Ripple Server. Please ensure the server is running on port 8810.";
          }
          return newMessages;
        });
      }
    });
  }, [isGenerating, sessionId, selectedModel, thinkingEnabled]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleSendMessage(input);
  };

  const handleQuickReply = (option: string) => {
    handleSendMessage(option);
  };

  const contextPercent = lastContextTokens > 0
    ? Math.min((lastContextTokens / MAX_CONTEXT_TOKENS) * 100, 100)
    : 0;
  const isContextWarning = contextPercent > 75;

  if (authState !== 'authenticated') {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-slate-50 font-[family-name:var(--font-inter)]">
        <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-purple-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob"></div>
          <div className="absolute top-[20%] right-[-10%] w-96 h-96 bg-yellow-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-2000"></div>
          <div className="absolute bottom-[-20%] left-[20%] w-96 h-96 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-4000"></div>
        </div>
        {authState === 'needs_auth' && (
          <div className="relative z-10 flex items-center justify-center h-full">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-md mx-4"
            >
              <div className="glass-bubble rounded-3xl p-8 shadow-xl">
                <div className="flex flex-col items-center mb-8">
                  <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-purple-500/30 mb-4">
                    <RippleIcon size={36} className="text-white" />
                  </div>
                  <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-violet-600 to-fuchsia-600">
                    Ripple
                  </h1>
                  <p className="text-sm text-slate-400 mt-2">请输入 API Key 以访问服务</p>
                </div>
                {authErrorMsg && (
                  <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    <span>{authErrorMsg}</span>
                  </div>
                )}
                <form onSubmit={handleAuthSubmit}>
                  <div className="relative mb-4">
                    <KeyRound size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="Enter your API Key"
                      className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-300 text-slate-700 placeholder:text-slate-400 transition-all"
                      autoFocus
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!keyInput.trim()}
                    className="w-full py-3.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold rounded-2xl shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-purple-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob"></div>
        <div className="absolute top-[20%] right-[-10%] w-96 h-96 bg-yellow-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-2000"></div>
        <div className="absolute bottom-[-20%] left-[20%] w-96 h-96 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-4000"></div>
        <div className="absolute bottom-[10%] right-[30%] w-72 h-72 bg-blue-300 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob"></div>
      </div>

      {/* App Container */}
      <div className="relative z-10 flex h-full w-full">

        {/* Sidebar */}
        <aside className="hidden md:flex flex-col w-72 glass-panel border-r border-white/40">
          <div className="p-6 flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
              <RippleIcon size={22} className="text-white" />
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-violet-600 to-fuchsia-600 tracking-tight">
              Ripple
            </h1>
          </div>

          <div className="px-4 pb-4 flex-1 overflow-y-auto">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="w-full bg-white/80 hover:bg-white border border-white/50 text-slate-700 rounded-2xl py-3 px-4 mb-6 flex items-center justify-center gap-2 shadow-sm transition-colors font-semibold"
              onClick={() => {
                setMessages([]);
                setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
                setLastContextTokens(0);
                createSession().then(setSessionId).catch((err) => {
                  if (err instanceof AuthError) {
                    clearApiKey();
                    setAuthState('needs_auth');
                    setAuthErrorMsg("API Key 已失效，请重新输入");
                  }
                });
              }}
            >
              <MessageSquare size={18} className="text-violet-500" />
              <span>New Chat</span>
            </motion.button>

            <div className="space-y-2">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider px-2 mb-3">Current Session</h2>
              <div className="p-3 rounded-2xl bg-white border border-violet-100 shadow-sm flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]"></div>
                <span className="truncate text-sm font-medium text-slate-700 font-mono text-xs">{sessionId || 'Connecting...'}</span>
              </div>
            </div>

            {/* Token Usage Summary in sidebar */}
            {tokenUsage.total_tokens > 0 && (
              <div className="mt-4 space-y-2">
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider px-2">Token Usage</h2>
                <div className="p-3 rounded-2xl bg-white border border-slate-100 shadow-sm space-y-2">
                  {lastContextTokens > 0 && (
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-500">Context</span>
                        <span className={`font-mono font-semibold ${isContextWarning ? 'text-amber-600' : 'text-slate-600'}`}>
                          {contextPercent.toFixed(0)}%
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isContextWarning ? 'bg-amber-400' : 'bg-violet-400'
                          }`}
                          style={{ width: `${contextPercent}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1 font-mono">
                        {formatTokens(lastContextTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)}
                      </p>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Total</span>
                    <span className="font-mono text-slate-600 font-semibold">
                      <span className="text-emerald-600">{formatTokens(tokenUsage.prompt_tokens)}</span>
                      {" / "}
                      <span className="text-blue-600">{formatTokens(tokenUsage.completion_tokens)}</span>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            className="p-4 m-4 rounded-2xl bg-white/50 border border-white/50 flex items-center justify-between cursor-pointer hover:bg-white/80 transition-colors"
            onClick={() => setIsSettingsOpen(true)}
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center">
                <Settings size={16} className="text-slate-600" />
              </div>
              <span className="text-sm font-semibold text-slate-700">Settings</span>
            </div>
          </div>
        </aside>

        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col relative">

          {/* Header */}
          <header className="h-16 px-6 flex justify-between items-center glass-panel border-b border-white/40 z-20">
            <div className="flex items-center gap-3">
              {/* Model selector */}
              <div className="relative">
                <button
                  onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                  className="flex items-center gap-2 text-slate-600 bg-white/50 px-3 py-1.5 rounded-full border border-white/60 hover:bg-white/80 transition-colors"
                >
                  <Cpu size={16} className="text-violet-500" />
                  <span className="text-sm font-semibold">{selectedModel}</span>
                  <ChevronDown size={14} className={`text-slate-400 transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                <AnimatePresence>
                  {isModelDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      transition={{ duration: 0.15 }}
                      className="absolute top-full left-0 mt-2 w-48 bg-white border border-slate-200 rounded-xl shadow-lg shadow-slate-200/50 overflow-hidden z-50"
                    >
                      <div className="p-1">
                        {models.length > 0 ? models.map(model => (
                          <button
                            key={model.id}
                            onClick={() => {
                              setSelectedModel(model.id);
                              setIsModelDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-between ${
                              selectedModel === model.id
                                ? 'bg-violet-50 text-violet-700'
                                : 'text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            {model.id}
                            {selectedModel === model.id && (
                              <div className="w-1.5 h-1.5 rounded-full bg-violet-500"></div>
                            )}
                          </button>
                        )) : (
                          <div className="px-3 py-2 text-sm text-slate-400">No models found</div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Thinking badge */}
              {thinkingEnabled && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-violet-50 text-violet-600 rounded-full border border-violet-100/50">
                  <Brain size={12} />
                  <span className="text-[10px] font-bold tracking-wide">THINKING</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {/* Token usage compact */}
              {tokenUsage.total_tokens > 0 && (
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-mono ${
                  isContextWarning
                    ? 'bg-amber-50 text-amber-700 border-amber-200/50'
                    : 'bg-slate-50 text-slate-500 border-slate-200/50'
                }`}>
                  {isContextWarning && <AlertTriangle size={12} />}
                  <span>{formatTokens(tokenUsage.prompt_tokens)}</span>
                  <span className="text-slate-300">|</span>
                  <span>{formatTokens(tokenUsage.completion_tokens)}</span>
                </div>
              )}

              {/* Status indicator */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-600 rounded-full border border-green-100/50">
                <div className={`w-2 h-2 rounded-full ${sessionId ? 'bg-green-500 animate-pulse' : 'bg-amber-500'}`}></div>
                <span className="text-xs font-bold tracking-wide">{sessionId ? 'READY' : 'CONNECTING'}</span>
              </div>
            </div>
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-8 pb-10">
            <div className="max-w-5xl mx-auto space-y-6">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                  <RippleIcon size={48} className="text-violet-200 mb-4" />
                  <p className="text-lg font-medium">How can I help you today?</p>
                </div>
              )}

              <AnimatePresence initial={false}>
                {messages.map((msg, index) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
                    className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                  >
                    {/* Avatar */}
                    <div className={`flex items-center gap-2 mb-2 px-1 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center shadow-sm ${msg.role === "user" ? "bg-gradient-to-br from-blue-400 to-indigo-500" : "bg-gradient-to-br from-violet-500 to-fuchsia-500"}`}>
                        {msg.role === "user" ? <User size={12} className="text-white" /> : <RippleIcon size={12} className="text-white" />}
                      </div>
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                        {msg.role === "user" ? "You" : "Ripple"}
                      </span>
                    </div>

                    {/* Message Bubble */}
                    {msg.role === "user" ? (
                      <div className="max-w-[80%] p-5 text-[15px] leading-relaxed shadow-sm bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-3xl rounded-tr-sm shadow-blue-500/20">
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                      </div>
                    ) : (
                      <div className="w-full md:max-w-[90%] space-y-3">
                        {/* Initial Loading Indicator */}
                        {isGenerating && !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0) && index === messages.length - 1 && (
                          <div className="glass-bubble rounded-2xl rounded-tl-sm p-4 shadow-sm inline-flex items-center gap-2 text-slate-400">
                            <Loader2 size={16} className="animate-spin" />
                            <span className="text-sm">Thinking...</span>
                          </div>
                        )}

                        {/* Tool Calls */}
                        {msg.toolCalls && msg.toolCalls.length > 0 && (
                          <div className="space-y-2">
                            {msg.toolCalls.map(tool => (
                              <div key={tool.id} className="rounded-2xl border border-slate-200/60 bg-white/70 overflow-hidden shadow-sm backdrop-blur-sm">
                                <motion.div
                                  whileHover={{ backgroundColor: "rgba(241, 245, 249, 1)" }}
                                  className="p-3 px-4 flex items-center justify-between cursor-pointer transition-colors"
                                  onClick={() => toggleTool(tool.id)}
                                >
                                  <div className="flex items-center gap-3">
                                    <div className={`p-1.5 rounded-lg ${tool.status === 'running' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                      <Wrench size={14} className={tool.status === 'running' ? 'animate-spin' : ''} />
                                    </div>
                                    <span className="font-bold text-slate-700 font-[family-name:var(--font-mono)] text-sm">
                                      {tool.name}
                                    </span>
                                    <span className="text-xs font-medium text-slate-400 bg-white px-2 py-0.5 rounded-full border border-slate-200">
                                      {tool.status === 'running' ? 'Running...' : 'Success'}
                                    </span>
                                  </div>
                                  <motion.div
                                    animate={{ rotate: expandedTools[tool.id] ? 90 : 0 }}
                                    transition={{ duration: 0.2 }}
                                  >
                                    <ChevronRight size={18} className="text-slate-400" />
                                  </motion.div>
                                </motion.div>

                                <AnimatePresence>
                                  {expandedTools[tool.id] && (
                                    <motion.div
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: "auto", opacity: 1 }}
                                      exit={{ height: 0, opacity: 0 }}
                                      transition={{ duration: 0.3, ease: "easeInOut" }}
                                      className="overflow-hidden"
                                    >
                                      <div className="p-4 bg-slate-900 text-emerald-400 font-[family-name:var(--font-mono)] text-[13px] border-t border-slate-200/50">
                                        <div className="mb-3">
                                          <span className="text-slate-500 select-none">{'// Arguments'}</span>
                                          <pre className="mt-1.5 opacity-90 overflow-x-auto">
                                            {typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}
                                          </pre>
                                        </div>
                                        {tool.result && (
                                          <div>
                                            <span className="text-slate-500 select-none">{'// Result'}</span>
                                            <pre className="whitespace-pre-wrap mt-1.5 opacity-90 text-slate-300 overflow-x-auto max-h-64 overflow-y-auto">{tool.result}</pre>
                                          </div>
                                        )}
                                      </div>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Text Content */}
                        {msg.content && (
                          <div className="glass-bubble rounded-2xl rounded-tl-sm p-5 text-[15px] leading-relaxed shadow-sm text-slate-700">
                            <MarkdownRenderer content={msg.content} />
                          </div>
                        )}

                        {/* AskUser Quick Reply Buttons */}
                        {msg.askUser && msg.askUser.options.length > 0 && !isGenerating && (
                          <div className="mt-2">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 px-1">Quick Reply</p>
                            <div className="flex flex-wrap gap-2">
                              {msg.askUser.options.map((option, i) => (
                                <motion.button
                                  key={i}
                                  whileHover={{ scale: 1.03 }}
                                  whileTap={{ scale: 0.97 }}
                                  onClick={() => handleQuickReply(option)}
                                  className="px-4 py-2 text-sm font-medium bg-white border border-violet-200 text-violet-700 rounded-xl hover:bg-violet-50 hover:border-violet-300 transition-colors shadow-sm"
                                >
                                  {option}
                                </motion.button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Active Generation Indicator */}
                        {isGenerating && index === messages.length - 1 && (msg.toolCalls?.length || msg.content) ? (
                          <div className="flex items-center gap-2 text-slate-400 text-sm py-2 px-2 animate-pulse">
                            <Loader2 size={16} className="animate-spin" />
                            <span>
                              {msg.toolCalls && msg.toolCalls.some(t => t.status === 'running')
                                ? "Executing tool..."
                                : "Thinking..."}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} className="h-32" />
            </div>
          </div>

          {/* Input Area */}
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-slate-50 via-slate-50/95 to-transparent z-20 pointer-events-none">
            <div className="max-w-5xl mx-auto pointer-events-auto">
              <form onSubmit={handleSend} className="relative flex items-center">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={isGenerating || !sessionId}
                  placeholder={isGenerating ? "Ripple is thinking..." : "Ask Ripple anything..."}
                  className="w-full glass-bubble rounded-full py-4 pl-6 pr-16 focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all text-base text-slate-700 placeholder:text-slate-400 shadow-lg shadow-slate-200/50 disabled:opacity-70"
                />
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  type="submit"
                  disabled={isGenerating || !sessionId || !input.trim()}
                  className="absolute right-2 w-10 h-10 bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white rounded-full flex items-center justify-center shadow-md shadow-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isGenerating ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} className="ml-0.5" />}
                </motion.button>
              </form>
              <div className="text-center mt-3">
                <span className="text-[10px] font-medium text-slate-400 tracking-wide">RIPPLE AGENT LOOP IS ACTIVE</span>
              </div>
            </div>
          </div>
        </main>
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
          setAuthState('needs_auth');
        }}
      />
    </div>
  );
}
