"use client";

import React, { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Loader2, Trash2, Clock, Settings, X, UserRound } from "lucide-react";
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
  userId: string;
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
  userId,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onOpenSettings,
  onCloseMobile,
}: SidebarProps) {
  const isDefaultUser = userId === "default";
  const contextPercent =
    lastContextTokens > 0 ? Math.min((lastContextTokens / MAX_CONTEXT_TOKENS) * 100, 100) : 0;
  const isContextWarning = contextPercent > 75;

  const [width, setWidth] = useState(256);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return;
        setWidth(Math.min(600, Math.max(200, startWidth + ev.clientX - startX)));
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
    [width]
  );

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <a
          href="https://github.com/echonoshy/ripple"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 transition-all"
          title="View on GitHub"
        >
          <div className="relative flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-b from-white/10 to-transparent shadow-[0_0_15px_rgba(255,255,255,0.05)] transition-all group-hover:border-white/20 group-hover:shadow-[0_0_20px_rgba(255,255,255,0.1)]">
            <div className="absolute inset-0 rounded-xl bg-white/5 opacity-0 transition-opacity group-hover:opacity-100" />
            <RippleIcon
              size={16}
              className="relative z-10 text-[#ededed] transition-transform duration-500 group-hover:scale-110"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="bg-gradient-to-br from-white to-white/50 bg-clip-text font-[family-name:var(--font-sans)] text-[17px] font-semibold tracking-wide text-transparent">
              Ripple
            </h1>
          </div>
        </a>
        <div className="flex items-center gap-1">
          <button
            onClick={onCloseMobile}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#888888] transition-colors hover:bg-white/5 hover:text-[#ededed] md:hidden"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4">
        {/* Current user — prominent, clickable to open settings */}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Click to change user in Settings"
          className={`group relative mb-4 flex w-full items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition-all duration-300 ${
            isDefaultUser
              ? "border-[#ff9d2a]/20 bg-gradient-to-br from-[#ff9d2a]/[0.08] to-transparent hover:border-[#ff9d2a]/40 hover:shadow-[0_0_15px_rgba(255,157,42,0.1)]"
              : "border-[#6366f1]/20 bg-gradient-to-br from-[#6366f1]/[0.08] to-transparent hover:border-[#6366f1]/40 hover:shadow-[0_0_15px_rgba(99,102,241,0.1)]"
          }`}
        >
          {/* Subtle background glow on hover */}
          <div className={`absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 ${
            isDefaultUser ? "bg-gradient-to-r from-[#ff9d2a]/10 to-transparent" : "bg-gradient-to-r from-[#6366f1]/10 to-transparent"
          }`} />
          
          <div
            className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border shadow-sm transition-transform duration-300 group-hover:scale-105 ${
              isDefaultUser
                ? "border-[#ff9d2a]/30 bg-[#ff9d2a]/10 text-[#ff9d2a]"
                : "border-[#6366f1]/30 bg-[#6366f1]/10 text-[#818cf8]"
            }`}
          >
            <UserRound size={16} />
          </div>
          <div className="relative min-w-0 flex-1">
            <p
              className={`text-[10px] font-medium tracking-wider uppercase ${
                isDefaultUser ? "text-[#ff9d2a]/80" : "text-[#818cf8]/80"
              }`}
            >
              {isDefaultUser ? "Default user" : "Signed in as"}
            </p>
            <p className="truncate font-[family-name:var(--font-mono)] text-sm font-semibold text-[#ededed] transition-colors group-hover:text-white">
              {userId}
            </p>
          </div>
          <Settings
            size={14}
            className={`relative transition-all duration-300 group-hover:rotate-90 ${
              isDefaultUser ? "text-[#ff9d2a]/50 group-hover:text-[#ff9d2a]" : "text-[#6366f1]/50 group-hover:text-[#818cf8]"
            }`}
          />
        </button>

        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          className="btn-primary mb-5 flex w-full items-center justify-center gap-2 text-sm"
          onClick={onNewChat}
          disabled={isGenerating}
        >
          <MessageSquare size={14} />
          <span>New Session</span>
        </motion.button>

        {/* Session List */}
        <div className="mb-6 space-y-1">
          <h2 className="mb-2 px-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
            Sessions
          </h2>
          {isLoadingSessions && sessions.length === 0 ? (
            <div className="flex justify-center p-4">
              <Loader2 size={16} className="animate-spin text-[#ededed]" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-[#666666]">No sessions yet</div>
          ) : (
            sessions.map((session, index) => (
              <motion.div
                key={session.session_id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.03, duration: 0.2 }}
              >
                <div
                  onClick={() => onSwitchSession(session.session_id)}
                  className={`group flex cursor-pointer items-center justify-between rounded-lg p-2.5 transition-all duration-150 ${
                    session.session_id === currentSessionId
                      ? "border-l-2 border-white bg-white/5"
                      : "border-l-2 border-transparent hover:translate-x-0.5 hover:bg-white/5"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div
                      className={`h-1.5 w-1.5 rounded-full ${
                        session.session_id === currentSessionId ? "bg-[#ededed]" : "bg-[#71717a]"
                      }`}
                    />
                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm ${
                          session.session_id === currentSessionId
                            ? "font-medium text-[#ededed]"
                            : "text-[#888888]"
                        }`}
                      >
                        {session.title || session.session_id.substring(0, 12) + "..."}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-[#666666]">
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
                    className="shrink-0 rounded-md p-1.5 text-[#666666] opacity-0 transition-all group-hover:opacity-100 hover:text-[#ff4444]"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </motion.div>
            ))
          )}
        </div>

        {/* Token Usage */}
        {tokenUsage.total_tokens > 0 && (
          <div className="space-y-2">
            <h2 className="px-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
              Stats
            </h2>
            <div className="space-y-2 rounded-lg border border-white/10 bg-[#0a0a0a] p-3">
              {lastContextTokens > 0 && (
                <div>
                  <div className="mb-1 flex justify-between font-[family-name:var(--font-mono)] text-xs">
                    <span className="text-[#666666]">CTX</span>
                    <span
                      className={`font-medium ${isContextWarning ? "text-[#ff4444]" : "text-[#ededed]"}`}
                    >
                      {contextPercent.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full transition-all ${isContextWarning ? "bg-[#ff4444]" : "bg-[#ededed]"}`}
                      style={{ width: `${contextPercent}%` }}
                    />
                  </div>
                  <p className="mt-1 font-[family-name:var(--font-mono)] text-xs text-[#666666]">
                    {formatTokens(lastContextTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)}
                  </p>
                </div>
              )}
              <div className="flex justify-between font-[family-name:var(--font-mono)] text-xs">
                <span className="text-[#666666]">Tokens</span>
                <span className="font-medium">
                  <span className="text-[#ededed]">↑{formatTokens(tokenUsage.prompt_tokens)}</span>
                  <span className="mx-1 text-[#666666]">/</span>
                  <span className="text-[#ededed]">
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
        className="mx-3 mb-3 flex cursor-pointer items-center gap-3 rounded-lg p-3 text-[#888888] transition-colors hover:bg-white/5 hover:text-[#ededed]"
        onClick={onOpenSettings}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0a0a0a]">
          <Settings size={15} className="text-[#888888]" />
        </div>
        <span className="text-sm">Settings</span>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="relative hidden shrink-0 md:flex" style={{ width: width }}>
        <aside className="surface-panel flex h-full w-full flex-col rounded-none border-t-0 border-r border-b-0 border-l-0">
          {sidebarContent}
        </aside>
        {/* Resize handle */}
        <div
          className="group absolute top-0 right-0 bottom-0 z-30 flex w-1.5 translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-[#ededed]/15"
          onMouseDown={handleResizeStart}
        >
          <div className="h-12 w-0.5 rounded-full bg-[#27272a] opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </div>

      {/* Mobile overlay sidebar */}
      {isMobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm md:hidden"
            onClick={onCloseMobile}
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/10 bg-[#0a0a0a] md:hidden">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
