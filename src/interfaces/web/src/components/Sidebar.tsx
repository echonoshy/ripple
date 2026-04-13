"use client";

import React from "react";
import { motion } from "framer-motion";
import { MessageSquare, Loader2, Trash2, Clock, Settings, X } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import { Session, UsageInfo } from "@/types";

const MAX_CONTEXT_TOKENS = 200_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  isLoadingSessions: boolean;
  isGenerating: boolean;
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  isMobileOpen: boolean;
  onNewChat: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
  onOpenSettings: () => void;
  onCloseMobile: () => void;
}

export default function Sidebar({
  sessions,
  currentSessionId,
  isLoadingSessions,
  isGenerating,
  tokenUsage,
  lastContextTokens,
  isMobileOpen,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onOpenSettings,
  onCloseMobile,
}: SidebarProps) {
  const contextPercent =
    lastContextTokens > 0 ? Math.min((lastContextTokens / MAX_CONTEXT_TOKENS) * 100, 100) : 0;
  const isContextWarning = contextPercent > 75;

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex items-center justify-between p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-purple-500/30">
            <RippleIcon size={22} className="text-white" />
          </div>
          <h1 className="bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-xl font-bold tracking-tight text-transparent">
            Ripple
          </h1>
        </div>
        <button
          onClick={onCloseMobile}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 md:hidden"
        >
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl border border-white/50 bg-white/80 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-white"
          onClick={onNewChat}
          disabled={isGenerating}
        >
          <MessageSquare size={16} className="text-violet-500" />
          <span>New Chat</span>
        </motion.button>

        {/* Session List */}
        <div className="mb-6 space-y-1">
          <h2 className="mb-2 px-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
            Recent
          </h2>
          {isLoadingSessions && sessions.length === 0 ? (
            <div className="flex justify-center p-4">
              <Loader2 size={16} className="animate-spin text-slate-400" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-slate-400">No sessions yet</div>
          ) : (
            sessions.map((session) => (
              <div
                key={session.session_id}
                onClick={() => onSwitchSession(session.session_id)}
                className={`group flex cursor-pointer items-center justify-between rounded-xl p-2.5 transition-all ${
                  session.session_id === currentSessionId
                    ? "bg-violet-50 shadow-sm"
                    : "hover:bg-white/60"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      session.session_id === currentSessionId
                        ? "bg-violet-500 shadow-[0_0_6px_rgba(139,92,246,0.5)]"
                        : "bg-slate-300"
                    }`}
                  />
                  <div className="min-w-0">
                    <p
                      className={`truncate text-sm ${
                        session.session_id === currentSessionId
                          ? "font-semibold text-violet-700"
                          : "text-slate-600"
                      }`}
                    >
                      {session.title || session.session_id.substring(0, 12) + "..."}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">
                      <Clock size={9} />
                      {new Date(session.last_active).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      <span className="mx-0.5">·</span>
                      {session.message_count} msgs
                    </p>
                  </div>
                </div>
                <button
                  onClick={(e) => onDeleteSession(session.session_id, e)}
                  className="shrink-0 rounded-lg p-1.5 text-slate-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Token Usage */}
        {tokenUsage.total_tokens > 0 && (
          <div className="space-y-2">
            <h2 className="px-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
              Usage
            </h2>
            <div className="space-y-2 rounded-xl border border-slate-100 bg-white/80 p-3">
              {lastContextTokens > 0 && (
                <div>
                  <div className="mb-1 flex justify-between text-[11px]">
                    <span className="text-slate-500">Context</span>
                    <span
                      className={`font-mono font-semibold ${isContextWarning ? "text-amber-600" : "text-slate-600"}`}
                    >
                      {contextPercent.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full transition-all ${isContextWarning ? "bg-amber-400" : "bg-violet-400"}`}
                      style={{ width: `${contextPercent}%` }}
                    />
                  </div>
                  <p className="mt-1 font-mono text-[9px] text-slate-400">
                    {formatTokens(lastContextTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)}
                  </p>
                </div>
              )}
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Total</span>
                <span className="font-mono font-semibold">
                  <span className="text-emerald-600">
                    ↑{formatTokens(tokenUsage.prompt_tokens)}
                  </span>
                  <span className="mx-1 text-slate-300">/</span>
                  <span className="text-blue-600">
                    ↓{formatTokens(tokenUsage.completion_tokens)}
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Settings */}
      <div
        className="mx-3 mb-3 flex cursor-pointer items-center gap-3 rounded-xl border border-white/50 bg-white/50 p-3 transition-colors hover:bg-white/80"
        onClick={onOpenSettings}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100">
          <Settings size={15} className="text-slate-500" />
        </div>
        <span className="text-sm font-medium text-slate-600">Settings</span>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="glass-panel hidden w-64 shrink-0 flex-col border-r border-white/40 md:flex">
        {sidebarContent}
      </aside>

      {/* Mobile overlay sidebar */}
      {isMobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm md:hidden"
            onClick={onCloseMobile}
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-white/95 shadow-2xl backdrop-blur-xl md:hidden">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
